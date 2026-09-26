import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const pageHeight = 800

let temporaryDirectory
let layoutPdfTextItems
let getTaggedTextItemOrder
let sanitizePages
let detectChapters
let normalizeLineMarks
let excludeMarkedLines
let normalizeMatchText
let insertManualLines
let reorderMarkedLines
let normalizeManualLines
let normalizeLineOrder
let hasUserContentOnPage
let matchLineMarkExists
let repairLeftoverHyphenation

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'pdf-to-epub-regression-'))
  await build({
    entryPoints: {
      pdfInspector: join(repositoryRoot, 'src/main/services/pdfInspector.ts'),
      textSanitizer: join(repositoryRoot, 'src/main/services/textSanitizer.ts')
    },
    outdir: temporaryDirectory,
    bundle: true,
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent'
  })

  const [pdfInspector, textSanitizer] = await Promise.all([
    import(pathToFileURL(join(temporaryDirectory, 'pdfInspector.mjs')).href),
    import(pathToFileURL(join(temporaryDirectory, 'textSanitizer.mjs')).href)
  ])
  layoutPdfTextItems = pdfInspector.layoutPdfTextItems
  getTaggedTextItemOrder = pdfInspector.getTaggedTextItemOrder
  sanitizePages = textSanitizer.sanitizePages
  detectChapters = textSanitizer.detectChapters
  normalizeLineMarks = textSanitizer.normalizeLineMarks
  insertManualLines = textSanitizer.insertManualLines
  reorderMarkedLines = textSanitizer.reorderMarkedLines
  normalizeManualLines = textSanitizer.normalizeManualLines
  normalizeLineOrder = textSanitizer.normalizeLineOrder
  hasUserContentOnPage = textSanitizer.hasUserContentOnPage
  matchLineMarkExists = textSanitizer.matchLineMarkExists
  repairLeftoverHyphenation = textSanitizer.repairLeftoverHyphenation
  excludeMarkedLines = textSanitizer.excludeMarkedLines
  normalizeMatchText = textSanitizer.normalizeMatchText
})

after(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

function positionedItem(str, x, y, width = Math.max(10, str.length * 5)) {
  return { str, x, y, width, height: 10, fontSize: 10, dir: 'ltr' }
}

function textLine(text, y, { x = 50, fontSize = 12, bold } = {}) {
  return { text, x, y, fontSize, ...(bold ? { bold: true } : {}) }
}

function positionedPage(lines, bodyFontSize = 12) {
  return { index: 0, lines, height: pageHeight, bodyFontSize }
}

test('layout keeps same-baseline column items separate and reads down each column', () => {
  const items = [
    positionedItem('First column, opening line.', 48, 720),
    positionedItem('Second column, opening line.', 360, 720),
    positionedItem('First column, middle line.', 48, 680),
    positionedItem('Second column, middle line.', 360, 680),
    positionedItem('First column, closing line.', 48, 640),
    positionedItem('Second column, closing line.', 360, 640)
  ]

  const text = layoutPdfTextItems(items).map((line) => line.text)

  assert.deepEqual(text, [
    'First column, opening line.',
    'First column, middle line.',
    'First column, closing line.',
    'Second column, opening line.',
    'Second column, middle line.',
    'Second column, closing line.'
  ])
})

test('layout follows tagged logical order when it differs from geometric order', () => {
  const items = [
    positionedItem('First in the tagged reading order.', 48, 520),
    positionedItem('Last in the tagged reading order.', 48, 720),
    positionedItem('Second in the tagged reading order.', 48, 620)
  ]

  const text = layoutPdfTextItems(items, { logicalOrder: [0, 2, 1] }).map((line) => line.text)

  assert.deepEqual(text, [
    'First in the tagged reading order.',
    'Second in the tagged reading order.',
    'Last in the tagged reading order.'
  ])
})

test('tagged item order follows the structure tree and accepts annotation leaves', () => {
  const firstText = { str: 'First item in the content stream.' }
  const secondText = { str: 'Second item in the content stream.' }
  const contentItems = [
    { type: 'beginMarkedContentProps', id: 'mcid-first' },
    firstText,
    { type: 'endMarkedContent' },
    { type: 'beginMarkedContentProps', id: 'mcid-second' },
    secondText,
    { type: 'endMarkedContent' }
  ]
  const structureTree = {
    role: 'Root',
    children: [
      { type: 'content', id: 'mcid-second' },
      { type: 'annotation', id: 'annotation-1' },
      { type: 'content', id: 'mcid-first' }
    ]
  }

  assert.deepEqual(getTaggedTextItemOrder(contentItems, structureTree), [1, 0])
})

test('tagged item order returns null when tagged coverage is partial', () => {
  const contentItems = [
    { type: 'beginMarkedContentProps', id: 'mcid-mapped' },
    { str: 'Mapped text item.' },
    { type: 'endMarkedContent' },
    { type: 'beginMarkedContentProps', id: 'mcid-unmapped' },
    { str: 'Unmapped text item.' },
    { type: 'endMarkedContent' }
  ]
  const structureTree = {
    role: 'Root',
    children: [{ type: 'content', id: 'mcid-mapped' }]
  }

  assert.equal(getTaggedTextItemOrder(contentItems, structureTree), null)
})

test('layout places a spanning headline between the upper and lower column flows', () => {
  const items = [
    positionedItem('Upper left column begins here.', 48, 720),
    positionedItem('Upper right column begins here.', 360, 720),
    positionedItem('Upper left column continues here.', 48, 680),
    positionedItem('Upper right column continues here.', 360, 680),
    positionedItem('Upper left column ends here.', 48, 640),
    positionedItem('Upper right column ends here.', 360, 640),
    positionedItem('A headline spanning both columns', 48, 600, 400),
    positionedItem('Lower left column begins here.', 48, 560),
    positionedItem('Lower right column begins here.', 360, 560),
    positionedItem('Lower left column continues here.', 48, 520),
    positionedItem('Lower right column continues here.', 360, 520),
    positionedItem('Lower left column ends here.', 48, 480),
    positionedItem('Lower right column ends here.', 360, 480)
  ]

  const text = layoutPdfTextItems(items).map((line) => line.text)

  assert.deepEqual(text, [
    'Upper left column begins here.',
    'Upper left column continues here.',
    'Upper left column ends here.',
    'Upper right column begins here.',
    'Upper right column continues here.',
    'Upper right column ends here.',
    'A headline spanning both columns',
    'Lower left column begins here.',
    'Lower left column continues here.',
    'Lower left column ends here.',
    'Lower right column begins here.',
    'Lower right column continues here.',
    'Lower right column ends here.'
  ])
})

test('layout preserves top-to-bottom flow on a one-column page', () => {
  const expected = [
    'The first line begins at the left margin.',
    'This line continues the same single column.',
    'A short line still belongs to that flow.',
    'The paragraph continues below it.',
    'Another line remains in the same column.',
    'The final line ends the page text.'
  ]
  const items = expected.map((str, index) =>
    positionedItem(str, index === 1 ? 55 : 48, 720 - index * 32)
  )

  const text = layoutPdfTextItems(items).map((line) => line.text)

  assert.deepEqual(text, expected)
})

test('sanitizePages joins physical lines that belong to one paragraph', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('One paragraph can cross a physical line', 600),
      textLine('without becoming two separate blocks.', 584)
    ])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'One paragraph can cross a physical line without becoming two separate blocks.'
  ])
})

test('sanitizePages keeps column flows separate when the next column starts slightly lower', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('The left column begins with a passage that continues', 720),
      textLine('through another line before it reaches its end.', 700),
      textLine('This final left-column line closes the passage.', 680),
      textLine('The right column starts just below the left column.', 670, { x: 300 }),
      textLine('Its lines continue independently down the page.', 650, { x: 300 }),
      textLine('This final right-column line closes its own passage.', 630, { x: 300 })
    ])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'The left column begins with a passage that continues through another line before it reaches its end. This final left-column line closes the passage.',
    'The right column starts just below the left column. Its lines continue independently down the page. This final right-column line closes its own passage.'
  ])
})

test('sanitizePages joins an unfinished paragraph to a flush-left continuation at the next page top', () => {
  const result = sanitizePages([
    positionedPage([textLine('The explanation is still open as the first page ends', 100)]),
    positionedPage([textLine('and resumes at the top of the next page.', 700)])
  ])

  assert.deepEqual(
    result.paragraphs.map(({ text, startPage }) => ({ text, startPage })),
    [{
      text: 'The explanation is still open as the first page ends and resumes at the top of the next page.',
      startPage: 0
    }]
  )
})

test('sanitizePages keeps a new flush-left paragraph separate after a complete sentence', () => {
  const result = sanitizePages([
    positionedPage([textLine('The preceding thought is a complete sentence.', 100)]),
    positionedPage([textLine('A fresh paragraph begins flush-left on this page.', 700)])
  ])

  assert.deepEqual(
    result.paragraphs.map(({ text, startPage }) => ({ text, startPage })),
    [
      { text: 'The preceding thought is a complete sentence.', startPage: 0 },
      { text: 'A fresh paragraph begins flush-left on this page.', startPage: 1 }
    ]
  )
})

test('sanitizePages repairs physical hyphenation across a page boundary', () => {
  const result = sanitizePages([
    positionedPage([textLine('The old index described the inter-', 100)]),
    positionedPage([textLine('national classification in detail.', 700)])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'The old index described the international classification in detail.'
  ])
})

test('sanitizePages repairs a page-turn hyphen slightly above the bottom continuation zone', () => {
  const result = sanitizePages([
    positionedPage([textLine('A equipa voltou nova-', 180)]),
    positionedPage([textLine('mente ao local no dia seguinte.', 700)])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'A equipa voltou novamente ao local no dia seguinte.'
  ])
})

test('sanitizePages repairs a U+2010 hyphen between lines', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('A equipa voltou nova\u2010', 600),
      textLine('mente ao local no dia seguinte.', 584)
    ])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'A equipa voltou novamente ao local no dia seguinte.'
  ])
})

test('sanitizePages preserves a line-ending hyphen when the next line starts a separate column flow', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('The left column describes one subject,', 720),
      textLine('and ends its final line with inter-', 706),
      textLine('national terms appear over in this column.', 692, { x: 300 }),
      textLine('They remain part of that column\'s own flow.', 678, { x: 300 })
    ])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'The left column describes one subject, and ends its final line with inter-',
    'national terms appear over in this column. They remain part of that column\'s own flow.'
  ])
})

test('sanitizePages does not absorb a subheading into an unfinished paragraph', () => {
  const result = sanitizePages([
    positionedPage([textLine('The earlier discussion has not reached its conclusion', 100)]),
    positionedPage([textLine('Important Consequences', 700, { fontSize: 18 })])
  ])

  assert.deepEqual(
    result.paragraphs.map(({ text, startPage, kind }) => ({ text, startPage, kind })),
    [
      { text: 'The earlier discussion has not reached its conclusion', startPage: 0, kind: 'text' },
      { text: 'Important Consequences', startPage: 1, kind: 'subheading' }
    ]
  )
})

test('sanitizePages does not absorb a chapter marker into an unfinished paragraph', () => {
  const result = sanitizePages([
    positionedPage([textLine('The previous chapter trails off before its final thought', 100)]),
    positionedPage([textLine('CAPÍTULO IV', 700)])
  ])

  assert.deepEqual(
    result.paragraphs.map(({ text, startPage }) => ({ text, startPage })),
    [
      { text: 'The previous chapter trails off before its final thought', startPage: 0 },
      { text: 'CAPÍTULO IV', startPage: 1 }
    ]
  )
})

test('sanitizePages detects a literary title without styling when isolated at the page top', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('A detenção', 700),
      textLine('Alguém devia ter caluniado Josef K., pois, sem ter feito', 600),
      textLine('nada de mal, vieram detê-lo uma manhã.', 584)
    ])
  ])

  assert.deepEqual(
    result.paragraphs.map(({ text, kind }) => ({ text: text.slice(0, 12), kind })),
    [
      { text: 'A detenção', kind: 'subheading' },
      { text: 'Alguém devia', kind: 'text' }
    ]
  )
})

test('sanitizePages keeps a title just below the old header cutoff in the body', () => {
  const result = sanitizePages([
    positionedPage([textLine('A detenção', 750), textLine('Primeira linha do corpo.', 600)])
  ])

  assert.ok(result.paragraphs.some((paragraph) => paragraph.text.includes('detenção')))
})

test('sanitizePages rejoins print hyphenation within a page', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('Pelo menos assim o entendeu o desconhecido, porque disse: «Não acha que seria melhor dei-', 700),
      textLine('xar-se estar onde está?»', 684)
    ])
  ])

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Pelo menos assim o entendeu o desconhecido, porque disse: «Não acha que seria melhor deixar-se estar onde está?»'
  ])
})

test('sanitizePages rejoins hyphenation even without reliable geometry', () => {
  const result = sanitizePages([
    { index: 0, lines: [{ text: 'contra todos os regula-', x: 0, y: 0, fontSize: 0 }], height: 0, bodyFontSize: 0 },
    { index: 1, lines: [{ text: 'mentos, também se tem comportado.', x: 0, y: 0, fontSize: 0 }], height: 0, bodyFontSize: 0 }
  ])

  assert.ok(result.paragraphs.some((paragraph) => paragraph.text.includes('regulamentos,')))
})

test('detectChapters opens a chapter at a user-marked line mid-page', () => {
  const sanitized = sanitizePages([
    positionedPage([textLine('Texto de abertura completo.', 100)]),
    positionedPage([
      textLine('A história continua por aqui dentro.', 700),
      textLine('e prossegue sem parar.', 684),
      textLine('O Regresso', 600)
    ])
  ])
  const plain = detectChapters(sanitized.paragraphs)
  assert.equal(plain.length, 1)

  const marked = detectChapters(
    sanitized.paragraphs,
    undefined,
    undefined,
    undefined,
    sanitized.pages,
    normalizeLineMarks([{ pageIndex: 1, lineText: 'O Regresso', level: 'chapter' }])
  )
  assert.equal(marked.length, 2)
  assert.equal(marked[1].title, 'O Regresso')
})

test('detectChapters forces a user-marked line to subheading', () => {
  const sanitized = sanitizePages([
    positionedPage([
      textLine('A história continua por aqui dentro.', 700),
      textLine('e prossegue sem parar.', 684),
      textLine('Recordações antigas', 600)
    ])
  ])
  const marked = detectChapters(
    sanitized.paragraphs,
    undefined,
    undefined,
    undefined,
    sanitized.pages,
    normalizeLineMarks([{ pageIndex: 0, lineText: 'Recordações antigas', level: 'subchapter' }])
  )
  assert.ok(marked[0].content.includes('@sub:Recordações antigas'))
})

test('normalizeLineMarks rejects invalid entries', () => {
  assert.deepEqual(
    normalizeLineMarks([
      { pageIndex: 2, lineText: 'O Regresso', level: 'chapter' },
      { pageIndex: -1, lineText: 'X', level: 'chapter' },
      { pageIndex: 1, lineText: ' ', level: 'chapter' },
      { pageIndex: 1, lineText: 'Y', level: 'nonsense' },
      null
    ]),
    [{ pageIndex: 2, matchText: 'O Regresso', level: 'chapter' }]
  )
})

test('normalizeLineMarks accepts ignore level', () => {
  assert.deepEqual(
    normalizeLineMarks([{ pageIndex: 3, lineText: '12', level: 'ignore' }]),
    [{ pageIndex: 3, matchText: '12', level: 'ignore' }]
  )
})

test('detectChapters never opens a chapter from an ignore mark', () => {
  const sanitized = sanitizePages([
    positionedPage([textLine('Texto de abertura completo.', 100)]),
    positionedPage([textLine('12', 700), textLine('Continuação do texto.', 600)])
  ])
  const marked = detectChapters(
    sanitized.paragraphs,
    undefined,
    undefined,
    undefined,
    sanitized.pages,
    normalizeLineMarks([{ pageIndex: 1, lineText: '12', level: 'ignore' }])
  )
  assert.equal(marked.length, 1)
})

test('excludeMarkedLines removes only exact normalized matches', () => {
  const pages = [
    { index: 0, lines: [textLine('12', 700), textLine('Texto real.', 684)] },
    { index: 1, lines: [textLine('12 homens vieram.', 700)] }
  ]
  const result = excludeMarkedLines(pages, [
    { pageIndex: 0, lineText: ' 12 ' },
    { pageIndex: 1, lineText: '12' }
  ])
  assert.deepEqual(result[0].lines.map((line) => line.text), ['Texto real.'])
  // '12 homens vieram.' não é igualdade exata: mantém-se
  assert.deepEqual(result[1].lines.map((line) => line.text), ['12 homens vieram.'])
  assert.equal(normalizeMatchText(' 12 '), '12')
})

test('insertManualLines adds a top line that joins the previous unfinished paragraph', () => {
  const missing = 'o livro para uma mesinha e levantando-se e disse que não estava autorizado a sair'
  const manual = [{ pageIndex: 1, anchor: 'start', text: missing }]
  const withManual = insertManualLines(
    [
      positionedPage([textLine('texto inacabado sem ponto', 100)]),
      { ...positionedPage([textLine('continuação aqui.', 700)]), index: 1 }
    ],
    manual
  )
  assert.equal(withManual[1].lines[0].text, missing)
  const result = sanitizePages(withManual)
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    `texto inacabado sem ponto ${missing}`,
    'continuação aqui.'
  ])
})

test('insertManualLines keeps a short title-like line as subheading', () => {
  const withManual = insertManualLines(
    [{ ...positionedPage([textLine('corpo a seguir.', 600)]), index: 0 }],
    [{ pageIndex: 0, anchor: 'start', text: 'O Regresso' }]
  )
  const result = sanitizePages(withManual)
  const title = result.paragraphs.find((paragraph) => paragraph.text === 'O Regresso')
  assert.ok(title && title.kind === 'subheading')
})

test('insertManualLines keeps manual end lines out of header/footer zones', () => {
  const withManual = insertManualLines(
    [positionedPage([textLine('corpo.', 400)])],
    [
      { pageIndex: 0, anchor: 'start', text: 'topo' },
      { pageIndex: 0, anchor: 'end', text: 'fundo' }
    ]
  )
  const [top, ...rest] = withManual[0].lines
  const bottom = rest[rest.length - 1]
  assert.equal(top.text, 'topo')
  assert.equal(bottom.text, 'fundo')
  assert.ok(top.y < pageHeight * 0.95 && top.y > pageHeight * 0.75)
  assert.ok(bottom.y > pageHeight * 0.05 && bottom.y < pageHeight * 0.2)
})

test('reorderMarkedLines swaps lines and keeps leftovers', () => {
  const pages = [
    positionedPage([
      textLine('primeira', 700),
      textLine('segunda', 684),
      textLine('terceira', 668)
    ])
  ]
  const reordered = reorderMarkedLines(pages, [
    { pageIndex: 0, orderedTexts: ['segunda', 'primeira', 'terceira'] }
  ])
  assert.deepEqual(reordered[0].lines.map((line) => line.text), ['segunda', 'primeira', 'terceira'])

  const partial = reorderMarkedLines(pages, [{ pageIndex: 0, orderedTexts: ['terceira', 'primeira'] }])
  assert.deepEqual(partial[0].lines.map((line) => line.text), ['terceira', 'primeira', 'segunda'])
})

test('normalizeManualLines and normalizeLineOrder reject invalid entries', () => {
  assert.deepEqual(
    normalizeManualLines([
      { pageIndex: 1, anchor: 'start', text: ' em falta ' },
      { pageIndex: 1, anchor: 'middle', text: 'x' },
      { pageIndex: -1, anchor: 'end', text: 'x' },
      { pageIndex: 0, anchor: 'end', text: '  ' }
    ]),
    [{ pageIndex: 1, anchor: 'start', text: 'em falta' }]
  )
  assert.deepEqual(
    normalizeLineOrder([
      { pageIndex: 2, orderedTexts: ['b', 'a'] },
      { pageIndex: 0, orderedTexts: ['só uma'] },
      { pageIndex: 1, orderedTexts: 'não é array' }
    ]),
    [{ pageIndex: 2, orderedTexts: ['b', 'a'] }]
  )
})

test('sanitizePages joins a lowercase continuation even when indented at the next page top', () => {
  const pages = [
    positionedPage([textLine('Imediatamente bateram à porta, e um homem, que', 100)]),
    {
      ...positionedPage([textLine('nunca vira naquela casa, entrou.', 700, { x: 70 })]),
      index: 1
    }
  ]
  const result = sanitizePages(pages)
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Imediatamente bateram à porta, e um homem, que nunca vira naquela casa, entrou.'
  ])
})

test('sanitizePages joins an unfinished page end with a lowercase start', () => {
  const pages = [
    positionedPage([textLine('que presumivelmente estava logo atrás dela para', 100)]),
    {
      ...positionedPage([textLine('continuar a ver tudo com atenção.', 700)]),
      index: 1
    }
  ]
  const result = sanitizePages(pages)
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'que presumivelmente estava logo atrás dela para continuar a ver tudo com atenção.'
  ])
})

test('sanitizePages still splits after a finished sentence before a lowercase page start', () => {
  const pages = [
    positionedPage([textLine('Ele entrou então na sala.', 100)]),
    {
      ...positionedPage([textLine('coisa estranha aconteceu depois.', 700)]),
      index: 1
    }
  ]
  const result = sanitizePages(pages)
  assert.equal(result.paragraphs.length, 2)
})

test('sanitizePages honors an explicit break over a lowercase continuation', () => {
  const pages = [
    positionedPage([textLine('Imediatamente bateram à porta, e um homem, que', 100)]),
    {
      ...positionedPage([textLine('nunca vira naquela casa, entrou.', 700)]),
      index: 1
    }
  ]
  const result = sanitizePages(pages, { 1: 'break' })
  assert.equal(result.paragraphs.length, 2)
})

test('sanitizePages rejoins a Tesseract paragraph split mid-sentence on the same page', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('Imediatamente bateram à porta, e um homem, que', 700),
      textLine('', 692),
      textLine('nunca vira naquela casa, entrou.', 684)
    ])
  ])
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Imediatamente bateram à porta, e um homem, que nunca vira naquela casa, entrou.'
  ])
})

test('sanitizePages keeps a blank-line split after a finished sentence', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('Terminou aqui a história.', 700),
      textLine('', 692),
      textLine('Novo começo agora mesmo.', 684)
    ])
  ])
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Terminou aqui a história.',
    'Novo começo agora mesmo.'
  ])
})

test('sanitizePages keeps the hyphen of Portuguese fixed compounds', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('Quer que Anna lhe traga o pequeno-', 700),
      textLine('almoço, disse K. sorrindo.', 684)
    ])
  ])
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Quer que Anna lhe traga o pequeno-almoço, disse K. sorrindo.'
  ])
})

test('sanitizePages still strips discretionary hyphens', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('Nunca tal tinha aconteci-', 700),
      textLine('do naquela manhã fria.', 684)
    ])
  ])
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Nunca tal tinha acontecido naquela manhã fria.'
  ])
})

test('sanitizePages strips a misleading ex- prefix', () => {
  const result = sanitizePages([
    positionedPage([textLine('texto fora de contex-', 700), textLine('to aqui escrito.', 684)])
  ])
  assert.ok(result.paragraphs[0].text.includes('contexto aqui escrito.'))
})

test('sanitizePages keeps enclitic lhe across a line break', () => {
  const result = sanitizePages([
    positionedPage([
      textLine('O guarda disse-', 700),
      textLine('lhe o desconhecido.', 684)
    ])
  ])
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'O guarda disse-lhe o desconhecido.'
  ])
})

test('sanitizePages keeps a compound hyphen across a page boundary', () => {
  const pages = [
    positionedPage([textLine('Quer que Anna lhe traga o pequeno-', 100)]),
    {
      ...positionedPage([textLine('almoço, disse K. sorrindo.', 700)]),
      index: 1
    }
  ]
  const result = sanitizePages(pages)
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.text), [
    'Quer que Anna lhe traga o pequeno-almoço, disse K. sorrindo.'
  ])
})

test('repairLeftoverHyphenation keeps compounds but repairs the rest', () => {
  assert.equal(repairLeftoverHyphenation('o pequeno- almoço'), 'o pequeno-almoço')
  assert.equal(repairLeftoverHyphenation('dei- xar-se estar'), 'deixar-se estar')
  assert.equal(repairLeftoverHyphenation('palavra - continua'), 'palavra - continua')
})

test('hasUserContentOnPage rescues marked pages but not ignore-only ones', () => {
  const chapter = [{ pageIndex: 4, matchText: 'A detenção', level: 'chapter' }]
  const ignoreOnly = [{ pageIndex: 4, matchText: '12', level: 'ignore' }]
  assert.equal(hasUserContentOnPage(4, chapter, []), true)
  assert.equal(hasUserContentOnPage(4, [], [{ pageIndex: 4, anchor: 'start', text: 'em falta' }]), true)
  assert.equal(hasUserContentOnPage(4, ignoreOnly, []), false)
  assert.equal(hasUserContentOnPage(3, chapter, []), false)
})

test('matchLineMarkExists finds tolerant matches on the marked page', () => {
  const sanitized = sanitizePages([
    positionedPage([textLine('Texto de abertura completo.', 100)]),
    {
      ...positionedPage([textLine('A detenção isolada aqui.', 700)]),
      index: 1
    }
  ])
  assert.equal(
    matchLineMarkExists(sanitized.paragraphs, { pageIndex: 1, matchText: 'A detenção', level: 'chapter' }),
    true
  )
  assert.equal(
    matchLineMarkExists(sanitized.paragraphs, { pageIndex: 1, matchText: 'Título inexistente', level: 'chapter' }),
    false
  )
  assert.equal(
    matchLineMarkExists(sanitized.paragraphs, { pageIndex: 0, matchText: 'A detenção', level: 'chapter' }),
    false
  )
})
