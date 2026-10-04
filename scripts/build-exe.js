'use strict';
/**
 * 打包啟動器,輸出到專案最外層的 stock-industry.exe(就是要提交進倉庫的那一支)。
 * 用法:npm run build:exe
 * 啟動器很少改動;改了 launcher/launcher.js 才需要重打包,並把新的 exe 一起提交。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'stock-industry.exe');

console.log('打包啟動器…');
execSync(`npx --yes @yao-pkg/pkg launcher/launcher.js --targets node20-win-x64 --output "${exe}"`, { cwd: root, stdio: 'inherit' });

// 改成「視窗程式」:執行時不會出現黑色主控台視窗(PE 標頭的 Subsystem 由 3=console 改為 2=GUI)
const b = fs.readFileSync(exe);
const off = b.readUInt32LE(0x3c) + 24 + 68;
if (b.toString('ascii', off - 92, off - 88) !== 'PE\0\0' || b.readUInt16LE(off) !== 3) throw new Error('exe 格式不符,無法改成視窗程式');
b.writeUInt16LE(2, off);
fs.writeFileSync(exe, b);
console.log(`完成:${exe}(${(b.length / 1048576).toFixed(1)} MB)`);
