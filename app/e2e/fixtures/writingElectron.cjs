const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

app.whenReady().then(() => {
  const preload = process.env.NOVALIST_WRITING_USER_CSS_PROBE === '1' ? join(__dirname, 'writingUserCssPreload.cjs') : undefined
  const window = new BrowserWindow({ width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload } })
  window.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
