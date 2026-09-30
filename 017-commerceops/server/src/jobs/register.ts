/** 各モジュールの Job / 保守処理を登録（worker 起動時に import される） */
import { registerMaintenanceTask } from './handlers.js';
import { purgeImportStaging } from '../modules/imports/maintenance.js';

registerMaintenanceTask('imports.purgeStaging', purgeImportStaging, 60);
