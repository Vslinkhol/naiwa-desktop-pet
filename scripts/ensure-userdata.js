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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 关于 npm scripts 里那个 `--no-sandbox`（第七次会话查清，不要误解）
 *
 *   package.json 的 start / dev 里带着 `--no-sandbox`，**这不是产品需要**，
 *   而是**开发期在工作区里跑的绕行**：
 *
 *   本机的工作区目录（`D:\dsh data\travel agent`）整棵树被标了
 *   `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，里面所有 exe 都继承 Low。
 *   Chromium 130 在这种目录里**初始化沙箱时会主动急停**
 *   （IMMEDIATE_CRASH，退出码 0x80000003 / -2147483645，零输出、无弹框，
 *   崩在日志初始化之前，所以连一句报错都没有）。
 *
 *   把**同一个 exe** 复制到普通目录就不需要这个参数（实测 D:\Apps\naiwa-pet：
 *   不带任何参数 → 4 个进程 + 窗口标题「奶蛙」）。
 *
 *   所以：
 *     · **不要**把 `--no-sandbox` 写死进 main.js / 打包配置（那是替所有用户关沙箱）；
 *     · **不要**给工作区撕标签（会削弱隔离，而且随时可能被写回）；
 *     · 要验证"不带参数能不能跑"，**必须在普通目录里测**，在工作区里测永远失败。
 *   详见 docs/04-项目现状与总交接.md §3.4 / §3.6 / §3.7。
 * ────────────────────────────────────────────────────────────────────────────
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