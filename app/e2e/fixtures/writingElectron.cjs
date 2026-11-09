const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  window.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
