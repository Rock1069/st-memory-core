import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const version = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version;
const validation = JSON.parse(fs.readFileSync(path.join(root,'artifacts/p1-validation.json'))); if (!validation.staticChecksPassed || validation.testExitCode !== 0 || validation.pluginVersion !== version) throw new Error('请先运行 npm run check');
for (const [name,expected] of Object.entries(validation.sourceSHA256)) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex') !== expected) throw new Error(`验证后源码改变：${name}；请重跑 npm run check`);
const ui = JSON.parse(fs.readFileSync(path.join(root,'artifacts/p1-ui-validation.json'))); if (ui.errors.length || ui.results.some(check => !check.passed)) throw new Error('请先完成 npm run test:ui');
const output = path.join(root,'artifacts',`st-memory-core-p1-${version}.zip`);
const walk = name => fs.statSync(path.join(root,name)).isDirectory() ? fs.readdirSync(path.join(root,name)).flatMap(child => walk(`${name}/${child}`)) : [name];
const files = ['index.js','manifest.json','styles.css','README.md','src','docs','功能覆盖清单.md','功能覆盖清单.json'].flatMap(walk);
const table = Array.from({length:256},(_,index) => {let value=index;for(let bit=0;bit<8;bit++) value=value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;return value >>> 0;});
const crc32 = bytes => {let value=0xffffffff;for(const byte of bytes)value=(value >>> 8) ^ table[(value ^ byte) & 255];return (value ^ 0xffffffff) >>> 0;};
const parts = []; const directory = []; let offset = 0;
for (const name of files) {
  const filename=Buffer.from(name,'utf8');const raw=fs.readFileSync(path.join(root,name));const compressed=deflateRawSync(raw);const crc=crc32(raw);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);
  parts.push(local,filename,compressed);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);directory.push(central,filename);offset+=local.length+filename.length+compressed.length;
}
const central=Buffer.concat(directory);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);fs.writeFileSync(output,Buffer.concat([...parts,central,end]));
const report = {path:output,version,sha256:crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),bytes:fs.statSync(output).size}; fs.writeFileSync(path.join(root,'artifacts/p1-package.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
