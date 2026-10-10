import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
const sources = [path.join(root,'index.js'),...walk(path.join(root,'src')).filter(p => p.endsWith('.js'))];
const issues = [];
for (const source of sources) {
  const syntax = spawnSync(process.execPath,['--check',source],{encoding:'utf8'}); if (syntax.status !== 0) issues.push({file:path.relative(root,source),error:syntax.stderr});
  for (const match of fs.readFileSync(source,'utf8').matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) if (!fs.existsSync(path.resolve(path.dirname(source),match[1]))) issues.push({file:path.relative(root,source),missing:match[1]});
}
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))); const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'))); const version = fs.readFileSync(path.join(root,'src/core/version.js'),'utf8').match(/'([^']+)'/)?.[1];
if (manifest.version !== pkg.version || version !== pkg.version) issues.push({error:'版本号不一致'});
for (const name of [manifest.js,manifest.css]) if (!fs.existsSync(path.join(root,name))) issues.push({missing:name});
const testFiles = walk(path.join(root,'tests')).filter(p => p.endsWith('.test.js')); const test = spawnSync(process.execPath,['--test','--test-reporter=tap',...testFiles],{encoding:'utf8',cwd:root});
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true}); fs.writeFileSync(path.join(root,'artifacts/p1-test-results.tap'),test.stdout + test.stderr);
const report = {pluginVersion:version,checkedAt:new Date().toISOString(),node:process.version,basis:'source_checks_and_simulated_host_tests',realSillyTavernTested:false,realModelTested:false,staticChecksPassed:issues.length === 0,testExitCode:test.status,tests:Number(test.stdout.match(/# tests (\d+)/)?.[1] ?? 0),passed:Number(test.stdout.match(/# pass (\d+)/)?.[1] ?? 0),issues,sourceSHA256:Object.fromEntries(sources.map(source => [path.relative(root,source).replaceAll('\\','/'),crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')]))};
fs.writeFileSync(path.join(root,'artifacts/p1-validation.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({...report,sourceSHA256:undefined},null,2));
if (issues.length || test.status !== 0) {console.log(test.stdout + test.stderr); process.exitCode = 1;}
