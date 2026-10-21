'use strict';
/**
 * 启动前预检：确保 Electron 的 userData 目录存在。
 *
 * 为什么需要它（实测踩过的坑）：
 *
 *   在 Windows + 受限令牌（比如 DSH 的文件沙箱）下，**Electron 进程自己建不了
 *   它的 userData 目录**，报 `EPERM: operation not permitted, mkdir
 *   'C:\Users\<用户>\AppData\Roaming\naiwa-pet'`。而 Chromium 初始化时拿不到
 *   userData 就会直接崩（进程退出码 -1073741819 / 0xC0000005 访问违例），
 *   表现是「启动后什么都没出现、也没有任何报错」——极难排查。
 *
 *   普通 Node 进程（也就是这个脚本）**有权限建**，所以放在 npm start 的最前面，
 *   在 Electron 起来之前把目录准备好。
 *
 * 目录已经存在时是空操作，没有副作用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须和 package.json 的 name 一致（Electron 的 app.getName() 取的就是它）
const APP_NAME = 'naiwa-pet';

function main() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const ud = path.join(appData, APP_NAME);

  try {
    fs.mkdirSync(ud, { recursive: true });
    console.log(`[预检] userData 目录就绪: ${ud}`);
  } catch (e) {
    // 建不出来也要放行：也许 Electron 这次能自己建（比如权限正常的机器）。
    // 真起不来时，这条信息是唯一的线索，所以必须打出来。
    console.error(`[预检] ⚠️ 无法创建 userData 目录: ${ud}`);
    console.error(`[预检]    原因: ${e.message}`);
    console.error('[预检]    若随后启动失败且毫无反应，多半就是这个原因。');
  }
}

main();