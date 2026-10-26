// Separate package entry: isolate preview data before loading any services.
import { app } from 'electron'
import path from 'path'
app.setName('Goga HackerOne Preview')
app.setPath('userData', path.join(app.getPath('appData'), 'Goga-HackerOne-Preview'))
require('./index')
