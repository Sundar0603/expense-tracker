import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { openDatabase, closeDatabase } from './db/connection'
import { registerIpc } from './ipc'
import { installDevHooks } from './dev-hooks'
import { repairEmailPayees } from './sync/repair'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Expense Tracker',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#111318',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  installDevHooks(win)

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  }
}

// Dev/testing: point the app at a scratch data directory so the real database is untouched.
if (process.env['ET_USER_DATA']) app.setPath('userData', process.env['ET_USER_DATA'])

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.sundar.expense-tracker')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const dbPath = join(app.getPath('userData'), 'expenses.sqlite')
  openDatabase(dbPath)
  repairEmailPayees()
  registerIpc({ dbPath })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Mac convention would keep the app alive; for a personal finance app we quit and close the DB.
  closeDatabase()
  app.quit()
})

app.on('before-quit', () => closeDatabase())
