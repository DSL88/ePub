const CANVAS_MODULE_PATH = ['@napi-rs', 'canvas'].join('/')

let cached: Promise<any | null> | null = null

export function loadCanvasModule(): Promise<any | null> {
  if (!cached) {
    cached = import(/* @vite-ignore */ CANVAS_MODULE_PATH)
      .then((mod: any) => mod?.default ?? mod)
      .catch(() => null)
  }
  return cached
}
