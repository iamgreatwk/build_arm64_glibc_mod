#!/usr/bin/env node
// ghbuild.js — 一条命令用 GitHub Actions 交叉编译 aarch64 (glibc) 软件
// 全程走 api.github.com（github.com 直连不通的网络也 OK；node>=18 内置 fetch，零依赖）
//
// 用法:
//   ghbuild url <源码URL> "<build_command>" [artifact_prefix]
//       触发 cross-build-from-url workflow → 轮询 → 下载 → 解出 tar.gz → 验证 ELF aarch64
//       例: ghbuild url https://busybox.net/downloads/busybox-1.36.1.tar.bz2 \
//              "make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- defconfig && make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- -j2 && mkdir -p \$PKGROOT/usr/bin && cp busybox \$PKGROOT/usr/bin/" busybox
//   ghbuild poll         查看最近 5 次编译状态
//   ghbuild dl [run_id]  下载指定 run（默认最新）的产物
//   ghbuild help         帮助
//
// Token 来源（按优先级）: 环境变量 GH_TOKEN / GITHUB_TOKEN，或 ~/.gh_token 文件
//   echo 'ghp_xxx' > ~/.gh_token && chmod 600 ~/.gh_token
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO = process.env.GH_REPO || 'iamgreatwk/build_arm64_glibc_mod';
const WF_URL = 'cross-build-from-url.yml';
const API = 'https://api.github.com';

// ---------- token ----------
function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const f = path.join(os.homedir(), '.gh_token');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  } catch (e) {}
  console.error('错误: 需要 token。设置环境变量 GH_TOKEN，或写入 ~/.gh_token 文件');
  console.error('  echo \'ghp_xxx\' > ~/.gh_token && chmod 600 ~/.gh_token');
  process.exit(1);
}
const TOKEN = getToken();

// ---------- API ----------
async function apiJson(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'ghbuild',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}: ${(await r.text()).slice(0, 300)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null; // 204 等空响应返回 null
}

// ---------- mini unzip（node zlib，解 upload-artifact 的 zip）----------
function unzipTarGz(zipBuf) {
  // 找 End of Central Directory
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf[i] === 0x50 && zipBuf[i + 1] === 0x4b && zipBuf[i + 2] === 0x05 && zipBuf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip');
  const cdCount = zipBuf.readUInt16LE(eocd + 10);
  const cdOff = zipBuf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let n = 0; n < cdCount; n++) {
    if (zipBuf[p] !== 0x50 || zipBuf[p + 1] !== 0x4b) break;
    const nameLen = zipBuf.readUInt16LE(p + 28);
    const extraLen = zipBuf.readUInt16LE(p + 30);
    const cmtLen = zipBuf.readUInt16LE(p + 32);
    const lho = zipBuf.readUInt32LE(p + 42);
    const compSize = zipBuf.readUInt32LE(p + 20);
    const name = zipBuf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.endsWith('.tar.gz')) {
      const method = zipBuf.readUInt16LE(lho + 8);
      const fnLen = zipBuf.readUInt16LE(lho + 26);
      const exLen = zipBuf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + fnLen + exLen;
      const raw = zipBuf.subarray(dataStart, dataStart + compSize);
      const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
      if (data) out.push({ name, data });
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// ---------- 验证 ELF aarch64 ----------
function checkElf(file) {
  const d = fs.readFileSync(file);
  if (d.length < 20 || d[0] !== 0x7f || d[1] !== 0x45 || d[2] !== 0x4c || d[3] !== 0x46) return '非 ELF';
  const cls = d[4] === 2 ? '64-bit' : d[4] === 1 ? '32-bit' : '?';
  const mach = cls === '64-bit' ? d.readUInt16LE(18) : d.readUInt16LE(18);
  const names = { 183: 'AARCH64 ✓', 40: 'ARM(32)', 62: 'x86-64', 3: 'i386' };
  return `${cls} machine=${mach} → ${names[mach] || '未知'}`;
}

// ---------- 主流程 ----------
async function cmdUrl(url, buildCmd, prefix) {
  const art = prefix || 'out';
  console.log('[1/5] 触发 Actions workflow (cross-build-from-url) ...');
  await apiJson('POST', `${API}/repos/${REPO}/actions/workflows/${WF_URL}/dispatches`, {
    ref: 'main',
    inputs: { source_url: url, build_command: buildCmd, artifact_prefix: art },
  });
  console.log(`      已触发: ${url}`);

  console.log('[2/5] 等待编译（每 20s 轮询，最长 10 分钟）...');
  let run = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 20000));
    const runs = await apiJson('GET', `${API}/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=5`);
    const wfr = runs.workflow_runs.find(r => r.path.includes(WF_URL));
    if (!wfr) continue;
    run = wfr;
    const st = run.status === 'completed' ? `completed(${run.conclusion})` : run.status;
    console.log(`      [${i + 1}] run #${run.run_number} ${st}${st === 'completed' ? '' : ' ...'}`);
    if (run.status === 'completed') break;
  }
  if (!run || run.status !== 'completed') { console.error('错误: 等待超时'); process.exit(1); }
  if (run.conclusion !== 'success') {
    console.error(`错误: 编译失败 (${run.conclusion})`);
    console.error(`查看日志: ${run.html_url}`);
    process.exit(1);
  }

  console.log('[3/5] 编译成功 ✓');
  await cmdDl(run.id, art);
}

async function cmdPoll() {
  const runs = await apiJson('GET', `${API}/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=5`);
  for (const r of runs.workflow_runs) {
    const st = r.status === 'completed' ? `completed(${r.conclusion})` : r.status;
    console.log(`run #${r.run_number} ${st.padEnd(18)} ${r.name}  ${r.created_at}`);
  }
}

async function cmdDl(runId, art) {
  const rid = runId || (await apiJson('GET', `${API}/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=1`)).workflow_runs[0].id;
  console.log(`[4/5] 下载 artifact (run #${rid}) ...`);
  const arts = await apiJson('GET', `${API}/repos/${REPO}/actions/runs/${rid}/artifacts`);
  const a = arts.artifacts[0];
  if (!a) { console.error('错误: 该 run 无 artifact'); process.exit(1); }
  const r = await fetch(a.archive_download_url, { headers: { 'Authorization': `Bearer ${TOKEN}`, 'User-Agent': 'ghbuild' } });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const zip = Buffer.from(await r.arrayBuffer());

  const files = unzipTarGz(zip);
  const tgz = files[0];
  if (!tgz) { console.error('错误: zip 里没有 tar.gz'); process.exit(1); }
  const tgzName = path.basename(tgz.name);
  fs.writeFileSync(tgzName, tgz.data);
  console.log(`      已保存: ${tgzName} (${tgz.data.length} bytes)`);

  // 解 tar.gz 验证产物
  console.log('[5/5] 解压验证 ...');
  const outDir = path.basename(tgzName, '.tar.gz');
  fs.mkdirSync(outDir, { recursive: true });
  let ok = false;
  const cp = require('child_process');
  const tries = [
    `tar -xzf "${tgzName}" -C "${outDir}"`,
    process.platform === 'win32' ? `tar -xzf "${tgzName}" -C "${outDir}"` : null,
  ].filter(Boolean);
  for (const c of tries) {
    try { cp.execSync(c, { stdio: 'ignore' }); ok = true; break; } catch (e) {}
  }
  if (!ok) {
    console.log('      提示: 本机无 tar，产物已保存为 ' + tgzName + '，请自行解压（设备端: tar -xzf ... -C /）');
    return;
  }
  // 找 ELF 验证
  const walk = (dir, acc) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, acc);
      else if (st.size > 1000) acc.push(p);
    }
    return acc;
  };
  const bigs = walk(outDir, []).slice(0, 5);
  for (const f of bigs) {
    try { console.log(`      ${f}  →  ${checkElf(f)}`); } catch (e) {}
  }
  console.log(`\n✅ 完成！产物: ${tgzName}（解压到设备: tar -xzf ${tgzName} -C /）`);
}

// ---------- CLI ----------
const [,, sub, ...args] = process.argv;
async function main() {
  if (sub === 'poll') return cmdPoll();
  if (sub === 'dl') return cmdDl(args[0]);
  if (sub === 'url' || sub === 'run') {
    const [u, cmd, p] = args;
    if (!u || !cmd) { console.error('用法: ghbuild url <源码URL> "<build_command>" [artifact_prefix]'); process.exit(1); }
    return cmdUrl(u, cmd, p);
  }
  if (sub === 'help' || !sub) {
    console.log(`ghbuild — 一条命令用 GitHub Actions 交叉编译 aarch64 (glibc)

用法:
  ghbuild url <源码URL> "<build_command>" [artifact_prefix]   一键编译（触发+轮询+下载+验证）
  ghbuild poll                                                查看最近 5 次状态
  ghbuild dl [run_id]                                         下载产物（默认最新）
  ghbuild help                                                本帮助

Token: 环境变量 GH_TOKEN / GITHUB_TOKEN，或 ~/.gh_token 文件（echo 'ghp_xxx' > ~/.gh_token）

示例:
  ghbuild url https://busybox.net/downloads/busybox-1.36.1.tar.bz2 \\
    "make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- defconfig && make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- -j2 && mkdir -p \\$PKGROOT/usr/bin && cp busybox \\$PKGROOT/usr/bin/" busybox`);
    return;
  }
  console.error('未知子命令: ' + sub + '（ghbuild help 看用法）');
  process.exit(1);
}
main().catch(e => { console.error('错误:', e.message); process.exit(1); });
