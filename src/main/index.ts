import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as path from 'node:path'
import { registerConversionHandlers, stopCurrentConversion } from './ipc/conversionHandlers'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1e2e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  window.on('ready-to-show', () => window.show())

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  window.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) {
      return
    }
    event.preventDefault()
  })

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

function blockExternalWindows(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.on('will-navigate', (event, url) => {
      const devServerUrl = process.env['ELECTRON_RENDERER_URL']
      if (devServerUrl && url.startsWith(devServerUrl)) {
        return
      }
      event.preventDefault()
    })
  })
}

app.whenReady().then(() => {
  blockExternalWindows()
  registerConversionHandlers(ipcMain, dialog)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopCurrentConversion()
})
