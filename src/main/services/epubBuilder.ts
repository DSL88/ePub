import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EPub } from 'epub-gen-memory'
import type { Options as EpubOptions } from 'epub-gen-memory'

export interface EpubChapterInput {
  title: string
  xhtml: string
}

export interface EpubImageInput {
  id: string
  buffer: Buffer
  ext: string
}

export interface BuildEpubPayload {
  title: string
  author?: string
  language?: string
  coverPath?: string
  chapters: EpubChapterInput[]
  images: EpubImageInput[]
  outPath: string
}

export type SendProgress = (stage: string, percent: number) => void

const BOOK_CSS = `
body { font-family: serif; line-height: 1.6; }
p.book-text { text-indent: 1.4em; margin: 0 0 0.25em 0; text-align: justify; }
h2.subheading { font-weight: 700; font-size: 1.15em; margin: 1.4em 0 0.6em 0; text-align: left; page-break-after: avoid; }
h3.subheading { font-weight: 700; font-size: 1.05em; margin: 1.2em 0 0.5em 0; text-align: left; page-break-after: avoid; }
div.book-image { margin: 1.4em 0; text-align: center; page-break-inside: avoid; }
div.book-image img { max-width: 100%; }
div.full-page-image { margin: 0; text-align: center; page-break-inside: avoid; }
div.full-page-image img { max-width: 100%; max-height: 100%; }
h2.book-chapter { text-align: center; margin: 1.2em 0; }
`.trim()

export function escapeXhtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const IMAGE_PLACEHOLDER_RE = /^@image:(.+)$/
/** `@sub:` = h2 (destaque por tamanho), `@sub3:` = h3 (destaque por peso) */
const SUBHEADING_PLACEHOLDER_RE = /^@sub(\d?):(.+)$/
/** imagem de página inteira rasterizada: id "page-<N 1-based>-full" */
const FULL_PAGE_IMAGE_RE = /^@image:page-(\d+)-full$/

function fullPageImageAlt(id: string): string {
  const match = id.match(/^page-(\d+)-full$/)
  const pageNumber = match ? match[1] : id
  return `Mapa / Imagem (página ${pageNumber})`
}

export function buildChapterBody(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  return blocks
    .map((block) => {
      const imageMatch = block.match(IMAGE_PLACEHOLDER_RE)
      if (imageMatch) {
        const imageId = escapeXhtml(imageMatch[1])
        // Página rasterizada na íntegra (mapa/gráfico sem texto): figura
        // dedicada com descrição; imagens dentro do texto ficam genéricas.
        if (FULL_PAGE_IMAGE_RE.test(block)) {
          return `<div class="full-page-image"><img src="${imageId}" alt="${escapeXhtml(fullPageImageAlt(imageMatch[1]))}" /></div>`
        }
        return `<div class="book-image"><img src="${imageId}" alt="" /></div>`
      }
      const subMatch = block.match(SUBHEADING_PLACEHOLDER_RE)
      if (subMatch) {
        const tag = subMatch[1] === '3' ? 'h3' : 'h2'
        return `<${tag} class="subheading">${escapeXhtml(subMatch[2])}</${tag}>`
      }
      return `<p class="book-text">${escapeXhtml(block)}</p>`
    })
    .join('\n')
}

export async function optimizeImages(images: EpubImageInput[]): Promise<EpubImageInput[]> {
  const sharp = (await import('sharp')).default
  const optimized: EpubImageInput[] = []

  for (const image of images) {
    try {
      const buffer = await sharp(image.buffer)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80 })
        .toBuffer()
      optimized.push({ id: image.id, buffer, ext: 'jpg' })
    } catch {
      optimized.push({ id: image.id, buffer: image.buffer, ext: image.ext })
    }
  }

  return optimized
}

function toEpubLanguage(language?: string): string {
  if (!language) {
    return 'pt'
  }
  const normalized = language.trim().toLowerCase()
  if (normalized === 'por' || normalized === 'pt-pt' || normalized === 'pt_br') {
    return 'pt'
  }
  return normalized
}

async function prepareCover(coverPath: string, tempDir: string): Promise<string | null> {
  try {
    const sharp = (await import('sharp')).default
    const optimized = await sharp(coverPath)
      .rotate()
      .resize({ width: 1200, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer()
    const coverFile = path.join(tempDir, 'book-cover.jpg')
    await fsp.writeFile(coverFile, optimized)
    return pathToFileURL(coverFile).href
  } catch {
    return null
  }
}

function rewriteImageSources(xhtml: string, imageFiles: Map<string, string>): string {
  let result = xhtml
  for (const [id, fileUrl] of imageFiles) {
    result = result
      .replaceAll(`src="${id}"`, `src="${fileUrl}"`)
      .replaceAll(`src='${id}'`, `src='${fileUrl}'`)
  }
  return result
}

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^-._A-Za-z0-9]/g, '')
    .slice(0, 40) || 'capitulo'
}

export async function buildEpub(
  { title, author, language, coverPath, chapters, images, outPath }: BuildEpubPayload,
  sendProgress: SendProgress = () => undefined
): Promise<string> {
  if (!title?.trim()) {
    throw new Error('O título do livro é obrigatório.')
  }
  if (!outPath) {
    throw new Error('Caminho de destino do EPUB não definido.')
  }

  sendProgress('build', 5)

  const optimizedImages = await optimizeImages(images)
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'epub-images-'))

  try {
    const imageFiles = new Map<string, string>()
    let done = 0
    for (const image of optimizedImages) {
      const file = path.join(tempDir, `${image.id}.jpg`)
      await fsp.writeFile(file, image.buffer)
      imageFiles.set(image.id, pathToFileURL(file).href)
      done++
      sendProgress('images', Math.round((done / Math.max(1, optimizedImages.length)) * 100))
    }

    const coverUrl = coverPath ? await prepareCover(coverPath, tempDir) : null

    const epubOptions: EpubOptions = {
      title: title.trim(),
      author: author?.trim() ? author.trim() : ['Desconhecido'],
      lang: toEpubLanguage(language),
      css: BOOK_CSS,
      tocTitle: 'Índice',
      prependChapterTitles: true,
      numberChaptersInTOC: true,
      date: new Date().toISOString().slice(0, 10),
      version: 3,
      ignoreFailedDownloads: false,
      verbose: false
    }
    if (coverUrl) {
      epubOptions.cover = coverUrl
    }

    const content = chapters.map((chapter, index) => ({
      title: chapter.title.trim() || 'Capítulo',
      content: rewriteImageSources(chapter.xhtml, imageFiles),
      // Zero-padded index keeps a stable filename sort in e-readers that
      // ignore the spine order.
      filename: `${String(index).padStart(3, '0')}-${slugify(chapter.title || `capitulo-${index + 1}`)}.xhtml`
    }))

    const epub = new EPub(epubOptions, content)
    await epub.render()
    const buffer = await epub.genEpub()

    const finalPath = /\.epub$/i.test(outPath) ? outPath : `${outPath}.epub`
    await fsp.mkdir(path.dirname(path.resolve(finalPath)), { recursive: true })
    await fsp.writeFile(finalPath, buffer)

    sendProgress('build', 100)
    return finalPath
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
