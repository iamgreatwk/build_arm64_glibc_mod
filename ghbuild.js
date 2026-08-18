#!/usr/bin/env node
// ghbuild.js — 用 GitHub Actions 交叉编译"本机已下载的源码"
// 全程走 api.github.com（github.com/uploads.github.com 直连不通的网络也 OK）
//
// 用法:
//   GITHUB_TOKEN=ghp_xxx node ghbuild.js <本地源码.tar.gz> <src_file> "<build_command>" [artifact_prefix]
//   例:
//   GITHUB_TOKEN=xxx node ghbuild.js dropbear-2022.83.tar.gz src/dropbear.tar.gz \
//     "make CC=aarch64-linux-gnu-gcc -j2 && mkdir -p \$PKGROOT/usr/sbin && cp dropbear \$PKGROOT/usr/sbin/" dropbear
//
// 流程: 上传源码到仓库(src/) -> 触发 workflow(build-from-uploaded-source.yml)
//       -> 轮询编译 -> 下载 artifact -> 保存本地并解压
const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = process.env.GH_REPO || 'iamgreatwk/build_arm64_glibc_mod';
const WF = 'build-from-uploaded-source.yml';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('错误: 需要 GITHUB_TOKEN 环境变量'); process.exit(1); }

const [,, localSrc, srcFile, buildCmd, prefix] = process.argv;
if (!localSrc || !srcFile || !buildCmd) {
  console.error('用法: node ghbuild.js <本地源码.tar.gz> <src_file仓库路径> "<build_command>" [artifact_prefix]');
  console.error('例:  GITHUB_TOKEN=xxx node ghbuild.js a.tar.gz src/a.tar.gz "make CC=aarch64-linux-gnu-gcc -j2 && cp a $PKGROOT/usr/bin/" a');
  process.exit(1);
}
const ART_PREFIX = prefix || path.basename(srcFile, '.tar.gz');

// JSON API（返回解析后的对象）
function apiJson(method, url, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'ghbuild',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
    const req = https.request({ hostname: 'api.github.com', path: u.pathname + u.search, method, headers }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode >= 300) rej(new Error(`HTTP ${r.statusCode}: ${d.slice(0, 300)}`));
        else res(d ? JSON.parse(d) : null);
      });
    });
    req.on('error', rej);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// 下载（返回 Buffer）
function apiBuf(url) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const headers = { 'Authorization': `Bearer ${TOKEN}`, 'User-Agent': 'ghbuild', 'Accept': 'application/vnd.github+json' };
    https.get({ hostname: 'api.github.com', path: u.pathname + u.search, headers }, r => {
      if (r.statusCode >= 300) { rej(new Error(`HTTP ${r.statusCode}`)); r.resume(); return; }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

async function main() {
  // 1. 上传源码
  console.log(`[1/5] 上传源码 ${localSrc} -> ${srcFile} ...`);
  const b64 = fs.readFileSync(localSrc).toString('base64');
  const putBody = { message: `upload source ${path.basename(srcFile)}`, content: b64 };
  try { putBody.sha = (await apiJson('GET', `https://api.github.com/repos/${REPO}/contents/${srcFile}`)).sha; } catch (e) {}
  await apiJson('PUT', `https://api.github.com/repos/${REPO}/contents/${srcFile}`, putBody);
  console.log('    上传完成');

  // 2. 触发 workflow
  console.log('[2/5] 触发 Actions workflow ...');
  await apiJson('POST', `https://api.github.com/repos/${REPO}/actions/workflows/${WF}/dispatches`, {
    ref: 'main',
    inputs: { src_file: srcFile, build_command: buildCmd, artifact_prefix: ART_PREFIX }
  });
  console.log('    已触发 (workflow_dispatch)');

  // 3. 轮询
  console.log('[3/5] 等待编译 ...');
  let run = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const runs = await apiJson('GET', `https://api.github.com/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=5`);
    const wfr = runs.workflow_runs.find(r => r.path.includes(WF));
    if (wfr) {
      run = wfr;
      const st = run.status === 'completed' ? `completed(${run.conclusion})` : run.status;
      console.log(`    [${i + 1}] ${st} (run #${run.run_number})`);
      if (run.status === 'completed') break;
    }
  }
  if (!run || run.status !== 'completed') { console.error('错误: 等待超时'); process.exit(1); }
  if (run.conclusion !== 'success') {
    console.error(`错误: 编译失败 (${run.conclusion})`);
    console.error(`查看日志: ${run.html_url}`);
    process.exit(1);
  }

  // 4. 下载 artifact
  console.log('[4/5] 下载 artifact ...');
  const arts = await apiJson('GET', `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/artifacts`);
  const art = arts.artifacts[0];
  if (!art) { console.error('错误: 无 artifact'); process.exit(1); }
  const zip = await apiBuf(`https://api.github.com/repos/${REPO}/actions/artifacts/${art.id}/zip`);
  const zipName = `${art.name}.zip`;
  fs.writeFileSync(zipName, zip);
  console.log(`    已保存: ${zipName} (${zip.length} bytes)`);

  // 5. 解压出 tar.gz
  console.log('[5/5] 解压 artifact ...');
  const outDir = `ghbuild_out_${Date.now()}`;
  fs.mkdirSync(outDir, { recursive: true });
  // 简易 zip 解压：zip 里只有一个 tar.gz（actions upload-artifact 打包）
  // 用 python/system unzip 解（node 无内置 zip）
  const cp = require('child_process');
  const unzipCmd = process.platform === 'win32'
    ? `powershell -NoProfile -Command "Expand-Archive -Path '${zipName}' -DestinationPath '${outDir}' -Force"`
    : `unzip -o '${zipName}' -d '${outDir}'`;
  try { cp.execSync(unzipCmd, { stdio: 'inherit' }); } catch (e) { console.error('解压失败(需系统 unzip/PowerShell):', e.message); process.exit(1); }
  const tgz = fs.readdirSync(outDir).find(f => f.endsWith('.tar.gz'));
  if (!tgz) { console.error('错误: artifact 里没有 tar.gz'); process.exit(1); }
  console.log(`\n✅ 完成！产物: ${path.join(outDir, tgz)}`);
  console.log(`   解压到设备: tar -xzf ${tgz} -C /`);
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
