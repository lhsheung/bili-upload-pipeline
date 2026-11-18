// ==UserScript==
// @name         哔哩哔哩投稿流水线 3.5
// @namespace    https://github.com/lhsheung/bili-upload-pipeline
// @version      3.5
// @description  PS5 游戏视频备份用：封面按原视频文件名精确匹配、批量设「仅自己可见」、失败项自动重试；不猜相似度、不等系统推荐帧
// @author       LauHingSheung
// @match        https://member.bilibili.com/platform/upload/video/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ===========================
  // 【2.3】单实例守卫 —— 重复安装/重复注入会产生多个实例，
  // 它们同时操作同一个页面（各自设元数据、各自提交）→ 重复上传。
  // 新实例启动时把旧实例停掉，旧实例的循环/定时器靠 isCurrentInstance() 自杀。
  // ===========================
  const BB_INSTANCE_ID = 'bb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const hadOldInstance = !!window.__bb;
  window.__bbInstanceId = BB_INSTANCE_ID;
  if (hadOldInstance) {
    try { window.__bb.autoUp.abort = true; } catch (e) { /* 忽略 */ }
    try { window.__bb.autoUp.running = false; } catch (e) { /* 忽略 */ }
    try { if (window.__bb.stopAllPipelines) window.__bb.stopAllPipelines(); } catch (e) { /* 忽略 */ }
    try { document.querySelectorAll('#bili-batch-panel').forEach((e) => e.remove()); } catch (e) { /* 忽略 */ }
    console.warn('[BB] 检测到旧实例，已请求其停止并移除旧面板');
  }
  function isCurrentInstance() { return window.__bbInstanceId === BB_INSTANCE_ID; }

  // ===========================
  // 配置
  // ===========================
  const CONFIG = {
    DECLARATION_TEXT: '内容无需标注',
    PRIVACY_TEXT: '仅自己可见',
    DELAY_BETWEEN_TASKS: 800,     // 每项之间留 0.8s：B站会限流「请求频率过高」，跑太快反而更慢
    DELAY_AFTER_CLICK: 120,       // 提速：同上
    ACCENT_COLOR: '#00a1d6',
    BG_COLOR: '#fff',
    PANEL_Z_INDEX: 99999,
    // 【新增：自动上传】一次性注入的视频个数，100 时 B站 自己并行上传、效率最高
    AUTO_BATCH: 100,
    AUTO_POLL_MS: 3000,        // U 盘接入轮询间隔
    AUTO_IDB: 'bb_upload_pipeline',
  };

  // ===========================
  // 工具函数
  // ===========================
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  /** 【新增】版本与仓库（升版本号时这里要一起改） */
  const MY_VERSION = '3.5';
  const REPO = 'lhsheung/bili-upload-pipeline';

  function cmpVer(a, b) {
    const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /** 取远端最新版本号：API 优先，403（未认证限流）就回落读 README 里的版本标记 */
  async function fetchLatestVersion() {
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (r.ok) {
        const j = await r.json();
        const tag = String(j.tag_name || '').replace(/^v/i, '');
        if (tag) return { ver: tag, url: j.html_url || ('https://github.com/' + REPO + '/releases'), via: 'api' };
      } else {
        logMsg('[更新] API 返回 ' + r.status + '，改读 README…');
      }
    } catch (e) { logMsg('[更新] API 失败(' + (e && e.message) + ')，改读 README…'); }
    // 回落：raw.githubusercontent.com 支持跨域、无限流
    const r2 = await fetch('https://raw.githubusercontent.com/' + REPO + '/main/README.md', { cache: 'no-store' });
    if (!r2.ok) throw new Error('README HTTP ' + r2.status);
    const txt = await r2.text();
    const m = txt.match(/当前版本\s*\*\*([\d.]+)\*\*/);
    if (!m) throw new Error('README 里没找到「当前版本 **x.y**」');
    return { ver: m[1], url: 'https://github.com/' + REPO + '/releases', via: 'readme' };
  }

  /** 写「关于」结果区：每次实时取元素（面板可能被重建，缓存的引用会失效） */
  function aboutResult(txt, html) {
    const b = document.getElementById('bb-about-result');
    if (!b) { logMsg('[更新] 结果区不在页面上，只写日志'); return; }
    if (html) b.innerHTML = html; else b.textContent = txt;
  }

  /** 【新增】检查更新 */
  async function checkUpdate() {
    aboutResult('检查中…');
    logMsg('[更新] 正在检查 GitHub 最新版本…');
    try {
      const info = await fetchLatestVersion();
      const latest = info.ver;
      if (cmpVer(latest, MY_VERSION) > 0) {
        logMsg('[更新] 发现新版本 v' + latest + '（当前 ' + MY_VERSION + '，来源 ' + info.via + '）');
        // 直接给 raw .user.js 链接：点了篡改猴会弹安装页，不用绕去 release 页面
        const rawUrl = 'https://raw.githubusercontent.com/' + REPO + '/main/bili-upload-pipeline-' + latest + '.user.js';
        aboutResult(null, '发现新版本 <b style="color:#1890ff">v' + escapeHtml(latest) + '</b>'
          + '（当前 ' + escapeHtml(MY_VERSION) + '）<br>'
          + '<a href="' + escapeHtml(rawUrl) + '" target="_blank" '
          + 'style="color:#1890ff;font-weight:600;font-size:12px">点这里安装 →</a> '
          + '<span style="color:#999;font-size:10px">篡改猴会弹安装页</span><br>'
          + '<a href="' + escapeHtml(info.url) + '" target="_blank" style="color:#999;font-size:10px">或看发布说明</a>');
        notify('发现新版本 v' + latest, 'info');
      } else {
        logMsg('[更新] 已是最新（本地 ' + MY_VERSION + ' / 远端 ' + latest + '，来源 ' + info.via + '）');
        aboutResult('已是最新版本（' + MY_VERSION + '）');
        notify('已是最新版本', 'success');
      }
    } catch (e) {
      logMsg('[更新] 检查失败: ' + (e && e.message));
      aboutResult(null, '检查失败：' + escapeHtml(e && e.message || '') + '<br>'
        + '<a href="https://github.com/' + REPO + '/releases" target="_blank" style="color:#1890ff">手动打开发布页</a>');
    }
  }

  function notify(message, type) {
    const types = { success: '#52c41a', error: '#ff4d4f', info: '#1890ff', warning: '#faad14' };
    // 【修复】之前每条都写死 fixed top/right，多条同时出现会完全重叠。
    // 改成统一容器 + flex 纵向堆叠，各条互不遮挡。
    let wrap = document.getElementById('bb-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'bb-toast-wrap';
      Object.assign(wrap.style, {
        position: 'fixed', top: '20px', right: '20px', zIndex: CONFIG.PANEL_Z_INDEX + 10,
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end',
        pointerEvents: 'none', maxWidth: '46vw',
      });
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.textContent = `[投稿流水线] ${message}`;
    Object.assign(el.style, {
      padding: '10px 16px', borderRadius: '6px', background: '#1e1e1e',
      color: types[type] || types.info, fontSize: '13px', fontWeight: '500',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)', maxWidth: '100%',
      wordBreak: 'break-word', transition: 'opacity 0.4s',
    });
    wrap.appendChild(el);
    // 最多同时显示 5 条，超了丢掉最老的，避免刷屏堆满半屏
    while (wrap.children.length > 5) wrap.removeChild(wrap.firstChild);
    setTimeout(() => { el.style.opacity = '0'; }, 3000);
    setTimeout(() => {
      el.remove();
      if (wrap && !wrap.children.length) wrap.remove();
    }, 3500);
  }
  function logMsg(msg) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    // 【修复】同时写进 window.__bbLog，即使面板被重建日志也不会丢
    if (!window.__bbLog) window.__bbLog = [];
    window.__bbLog.push(line);
    if (window.__bbLog.length > 600) window.__bbLog.shift();
    const el = document.getElementById('bili-batch-log');
    if (!el) return;
    el.textContent += line + '\n';
    el.scrollTop = el.scrollHeight;
  }

  /** 【补回】轮询等待条件成立；之前删通用引擎时误删，导致一键流程每项都抛 waitFor is not defined */
  function waitFor(fn, timeout, interval) {
    const limit = timeout || 2000;
    const step = interval || 100;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = !!fn(); } catch (e) { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() - t0 >= limit) return resolve(false);
        setTimeout(tick, step);
      };
      tick();
    });
  }

  // ==================================================
  // ↓↓↓ 【新增】B站限流（请求频率过高）检测与退避 ↓↓↓
  // ==================================================
  const RATE_RE = /请求(过于)?频繁|频率过高|操作(过于)?频繁|稍后再试|请稍后重试|too many requests/i;

  /** 扫可见的 toast / message，命中"请求频率过高"就返回提示文字 */
  function rateLimitHit() {
    const nodes = document.querySelectorAll(
      '.bili-toast, .bcc-message, .bcc-toast, .el-message, [class*="toast"], [class*="message"]'
    );
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (!t || t.length > 60) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && RATE_RE.test(t)) return t;
    }
    return '';
  }

  /**
   * 命中限流就一直等，直到 B站 不再提示「请求频率过高」才返回（不是固定等几秒）。
   * 仍然提示就继续等，最多等 maxWait（默认 3 分钟），避免死等。
   */
  async function backoffIfLimited(maxWait) {
    if (!rateLimitBackoff) return false;
    let hit = rateLimitHit();
    if (!hit) return false;
    const limit = maxWait || 180000;
    const t0 = Date.now();
    while (hit && Date.now() - t0 < limit) {
      logMsg('  [限流] B站提示「' + hit + '」→ 暂停，等它不提示才继续（已停 ' + Math.round((Date.now() - t0) / 1000) + 's）');
      await delay(3000);
      hit = rateLimitHit();
    }
    if (!hit) logMsg('  [限流] 已不再提示，继续');
    else logMsg('  [限流] 等了 ' + Math.round((Date.now() - t0) / 1000) + 's 仍在提示，先继续');
    return true;
  }

  /** 设置封面；失败且命中限流时，等限流解除后补当前这一张（不是跳过它） */
  async function setCoverWithBackoff(file) {
    let ok = await setCover(file);
    if (ok || !rateLimitBackoff) return ok;
    if (!rateLimitHit()) return ok;
    for (let i = 0; i < 2 && !ok; i++) {
      logMsg('  封面没设上 + 命中限流 → 等它不提示，再补当前这一张（补第 ' + (i + 1) + ' 次）');
      await backoffIfLimited();
      ok = await setCover(file);
    }
    return ok;
  }

  // ==================================================
  // ↓↓↓ 【新增 1】文件名匹配（原版没有，原版是一张封面铺全部）↓↓↓
  // ==================================================
  function baseName(name) {
    return String(name || '').replace(/^.*[\/\\]/, '').replace(/\.[^.\/\\]+$/, '');
  }

  /** 归一化：只做「去路径 / 去扩展名 / 小写 / 全角转半角」。
   *  【重要】不再删空格、下划线、连字符、点号，也不再去掉 (1) 副本号 ——
   *  那些本身就是文件名的一部分，删掉会把「课程 第01讲」和「课程第01讲」、
   *  「图(1)」和「图」认成同一个文件，进而串图。 */
  function normName(str) {
    let s = baseName(str).trim().toLowerCase();
    s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[\u3000]/g, ' ');
    return s;
  }

  function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  }

  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach((x) => { if (B.has(x)) inter++; });
    return (2 * inter) / (A.size + B.size);
  }

  function digitSig(s) { return (s.match(/\d{3,}/g) || []).join(''); }
  function stripDigits(s) { return s.replace(/\d{3,}/g, ''); }

  /** 视频名 vs 封面名 打分；关键点：先剔掉长数字串再算相似度，
   *  否则「影之刃零_240」和「黑神话_240」会因为共有时间戳而错配 */
  function matchScore(videoBase, coverName) {
    const a = normName(videoBase);
    const b = normName(coverName);
    if (!a || !b) return 0;
    if (a === b) return 1;

    const aCore = stripDigits(a);
    const bCore = stripDigits(b);

    let score;
    if (aCore && bCore) {
      score = dice(aCore, bCore);
      const short = aCore.length <= bCore.length ? aCore : bCore;
      const long = aCore.length <= bCore.length ? bCore : aCore;
      if (short.length >= 2 && long.indexOf(short) !== -1) {
        score = Math.max(score, 0.55 + 0.4 * (short.length / long.length));
      }
    } else {
      score = dice(a, b);
    }

    const da = digitSig(a);
    const db = digitSig(b);

    // 语义相同但只有一方带数字 → 通用封面，压到 0.8，别抢走精确同名的
    if (aCore && bCore && aCore === bCore) score = (da && db) ? 1 : 0.8;

    // 数字串不一致且不成前缀关系 → 大概率是另一条素材
    if (da && db && da !== db) {
      const compatible = da.indexOf(db) === 0 || db.indexOf(da) === 0;
      if (!compatible) score *= 0.45;
    }
    return Math.min(1, score);
  }

  /** 从任务卡片取视频文件名。
   *  原版只写了 task.getAttribute('title') 拿来打日志，没做兜底 */
  function getTaskTitle(taskEl) {
    if (!taskEl) return '';
    const attr = taskEl.getAttribute('title') || taskEl.getAttribute('data-title');
    if (attr && attr.trim()) return attr.trim();

    const prefer = taskEl.querySelector(
      '[class*="file-name"],[class*="filename"],[class*="task-name"],[class*="task-title"],[class*="name"],[class*="title"]'
    );
    if (prefer && prefer.textContent.trim()) return prefer.textContent.trim();

    const txt = (taskEl.textContent || '').replace(/\s+/g, ' ').trim();
    const m = txt.match(/([^\s\/\\]{2,}\.(?:mp4|mov|mkv|flv|webm|avi|m4v|ts|wmv|mts|m2ts))/i);
    if (m) return m[1];
    return txt.replace(/^(等待上传|上传中|上传完成|已完成|上传失败|失败)\s*/, '').slice(0, 120);
  }
  // ↑↑↑ 【新增 1】结束 ↑↑↑

  // ===========================
  // 全局状态
  // ===========================
  let selectedCoverFile = null;
  let selectedCoverBase64 = null;
  let processing = false;
  let abortFlag = false;

  // ↓↓↓ 【新增 2】封面池 / 匹配模式 / 标题设置 ↓↓↓
  let coverPool = [];          // [{id, file, name, url}]
  let coverMode = 'match';     // 【按用户要求】默认按文件名匹配已选的一批封面
  let systemFrame = 0;         // 用系统推荐的第几张（0 基）
  let titleFromName = true;    // 标题沿用原视频文件名
  let titleTpl = '';           // 【新增】自定义标题模板：{name}=原文件名；填了模板就用它，否则按「标题沿用」
  let spaceHide = true;        // 【新增】在个人空间-投稿中隐藏
  let waitUploadDone = false;  // 【修复】默认不等；勾选后最多等 2 分钟
  let privacyWant = '仅自己可见';   // 可见范围：公开可见 / 仅自己可见
  let customTags = '';              // 自定义标签（逗号分隔）
  let skipCoverThisRun = false;
  let rateLimitBackoff = false;   // 【默认关】遇到「请求频率过高」是否自动暂停；面板开关控制     // 本次一键是否跳过封面
  let promoOn = false;              // 增加商业推广信息
  let categoryWant = '';       // 【新增】目标分区，留空=不改
  let introText = '';          // 【新增】简介内容（空=不改）
  let fanText = '';            // 【新增】粉丝动态内容（空=不改）

  /** 【新增】还在上传的任务数（实测：任务卡显示「上传完成」才算好） */
  function countUploading() {
    return getTasks().filter((t) => !/上传完成/.test(t.textContent || '')).length;
  }

  /** 【新增】阻塞等待，直到全部上传完成（默认最多等 60 分钟） */
  async function waitAllUploaded(maxMin) {
    const limit = (maxMin || 60) * 60 * 1000;
    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < limit) {
      if (abortFlag) { logMsg('  已中止等待'); return false; }
      const n = countUploading();
      if (n !== last) {
        logMsg('  等待上传：还剩 ' + n + ' 个未完成');
        showProgress(0, 1, '等待上传，还剩 ' + n + ' 个…');
        last = n;
      }
      if (n === 0) { hideProgress(); logMsg('  全部上传完成，开始执行'); return true; }
      await delay(2000);
    }
    hideProgress();
    logMsg('  [WARN] 等待上传超过 ' + (maxMin || 60) + ' 分钟，先按现状执行');
    return false;
  }

  // 【新增】「一键全部设置」包含哪些项（可在面板勾选）
  const runOpts = {
    title: true, cover: true, declaration: true, privacy: true,
    category: true, tags: true, spaceHide: true,
    watermark: false, danmaku: false, comment: false, featured: false,
    intro: false, fan: false, schedule: false, erchuang: false, dolby: false, hires: false,
  };
  let stripTimestamp = false;  // 标题里去掉末尾时间戳
  let underscoreToSpace = false;
  let matchMap = [];           // [{key, task, videoBase, title, coverId, score, manual}]
  // 【关键】匹配结果直接绑在 .task 元素上：B站列表会重排/移除，按数组下标取 row 会串到别的视频
  const taskRowBind = new WeakMap();
  let manualBind = {};         // 视频key -> 封面id（手动改绑）
  // ↑↑↑ 【新增 2】↑↑↑

  // ===========================
  // 表单操作函数（基于实际 DOM 结构）
  // ===========================

  /** 获取任务列表 */
  function getTasks() {
    return [...document.querySelectorAll('.task')];   // 【修复】返回数组，否则 countUploading().filter 抛错
  }

  /** 点击选中一个任务 */
  function selectTask(taskEl) {
    taskEl.click();
    // 一些任务可能已经有 task-selected 类
  }

  /** 设置创作声明 →「内容无需标注」
   *  原理: 点击 .bcc-select-input-inner 打开下拉，然后点击 .bcc-select-option-list 中的对应项 */
  async function setDeclaration(text) {
    text = text || CONFIG.DECLARATION_TEXT;

    const cur = document.querySelector('.bcc-select-input-inner');
    if (cur && (cur.value || '').trim() === text) {
      logMsg('  创作声明已是「' + text + '」，跳过');
      return true;
    }

    logMsg('  设置创作声明...');
    const sel = document.querySelector('.bcc-select');
    if (sel) sel.click();
    // 【提速】下拉项一出现就取，不再固定睡 450ms
    await waitFor(() => [...document.querySelectorAll('li')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (el.textContent || '').trim() === text;
    }), 600, 60);

    // 【实测】下拉选项就是页面上的普通 li，按「可见 + 文字完全一致」匹配
    let target = [...document.querySelectorAll('li')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (el.textContent || '').trim() === text;
    });
    if (!target) {
      target = [...document.querySelectorAll('.bcc-select-option-list li, .el-select-dropdown__item')]
        .find((el) => (el.textContent || '').trim() === text);
    }
    if (!target) {
      logMsg('  [WARN] 下拉里没有「' + text + '」');
      document.body.click();
      return false;
    }

    target.click();
    await waitFor(() => {
      const a = document.querySelector('.bcc-select-input-inner');
      return !!(a && (a.value || '').trim() === text);
    }, 700, 60);
    const after = document.querySelector('.bcc-select-input-inner');
    const ok = !!(after && (after.value || '').trim() === text);
    logMsg('  创作声明 →「' + text + '」' + (ok ? '' : '（未确认，实际：' + (after ? after.value : '?') + '）'));
    return ok;
  }

  /** 设置可见范围 →「仅自己可见」
   *  原理: 找到 .check-radio-v2-name 包含目标文字的元素，点击其父级 radio */
  async function setPrivacy(text) {
    text = text || CONFIG.PRIVACY_TEXT;

    // 【实测】每项 = .check-radio-v2-container；选中状态 = 内层 .check-radio-v2-box-checked
    const box = [...document.querySelectorAll('.check-radio-v2-container')]
      .find((c) => (c.textContent || '').trim().includes(text));
    if (!box) { logMsg('  [WARN] 未找到可见范围「' + text + '」'); return false; }

    const isOn = () => !!box.querySelector('.check-radio-v2-box-checked');
    if (isOn()) { logMsg('  可见范围已是「' + text + '」，跳过'); return true; }

    box.click();
    await waitFor(isOn, 600, 60);
    if (!isOn()) {
      const name = box.querySelector('.check-radio-v2-name');
      if (name) { name.click(); await waitFor(isOn, 500, 60); }
    }
    const ok = isOn();
    logMsg('  可见范围 →「' + text + '」' + (ok ? '' : '（未生效）'));
    return ok;
  }

  /** 设置标签 — 点击推荐标签 hot-tag-container */
  async function setTagsAuto() {
    const hotTags = document.querySelectorAll('.hot-tag-container');
    if (hotTags.length === 0) {
      // 尝试手动输入
      const tagInput = document.querySelector('input[placeholder*="标签"]');
      if (!tagInput) { logMsg('  [WARN] 未找到标签输入'); return false; }
      logMsg('  未找到推荐标签，手动输入「绘画」...');
      tagInput.focus();
      tagInput.value = '绘画';
      tagInput.dispatchEvent(new Event('input', { bubbles: true }));
      tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      await delay(150);
      return true;
    }

    // 点击第一个未选中的推荐标签
    for (const tag of hotTags) {
      if (tag.classList.contains('hot-tag-container-selected')) {
        logMsg('  标签「' + tag.textContent.trim() + '」已选中，跳过');
        continue;
      }
      tag.click();
      logMsg('  标签 →「' + tag.textContent.trim() + '」');
      await waitFor(() => tag.classList.contains('hot-tag-container-selected'), 500, 60);
      return true;
    }

    logMsg('  所有推荐标签均已选中');
    return true;
  }

  /** 设置封面 — 点开封面编辑器，找到封面编辑器内的 file input 注入文件 */
  /** 【新增】把元素结构压成一行，用于日志自证（找不到选择器时自动打印） */
  function dumpNode(el, maxDepth) {
    if (!el) return '(null)';
    const lines = [];
    (function walk(node, depth) {
      if (depth > (maxDepth || 3) || lines.length > 28) return;
      const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      const tag = node.tagName.toLowerCase() + (cls ? '.' + cls : '');
      const extra = node.tagName === 'INPUT' ? '[' + (node.type || '') + (node.accept ? ' accept=' + node.accept : '') + ']' : '';
      lines.push('  '.repeat(depth) + tag + extra);
      for (const c of node.children) walk(c, depth + 1);
    })(el, 0);
    return lines.join(' | ');
  }

  /** 【新增】真实点击：B站的 bcc-button 不认 el.click()，必须派发整套指针事件 */
  function realClick(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      try {
        if (t.indexOf('pointer') === 0 && window.PointerEvent) el.dispatchEvent(new PointerEvent(t, base));
        else el.dispatchEvent(new MouseEvent(t, base));
      } catch (e) { /* 忽略单个事件失败 */ }
    });
    return true;
  }

  async function setCover(file) {
    if (!file) { logMsg('  [WARN] 未选择封面文件'); return false; }

    // 【修复】按文件名匹配要能替换已有封面：不再一律跳过
    const hasEmpty = !!document.querySelector('.cover-empty-pill');
    if (!hasEmpty && !document.querySelector('.edit-text')) {
      logMsg('  封面已存在且找不到更换入口，跳过');
      return true;
    }
    const sz = await probeSize(file);
    const ratio = (sz.w && sz.h) ? (sz.w / sz.h) : 0;
    logMsg('  上传封面文件: ' + file.name + '（' + (sz.w || '?') + '×' + (sz.h || '?') + (ratio ? '，比例 ' + ratio.toFixed(2) : '') + '）');
    if (ratio && Math.abs(ratio - 16 / 9) > 0.25) {
      logMsg('  [WARN] 这张不是 16:9（B站封面位是 16:9），显示会被裁切；要换 16:9 那张请在面板下拉里改绑');
    }

    // 1. 打开封面编辑器
    //    【实测】真实入口是 .cover-empty-pill / .add-text（文字「添加封面」），不是 .edit-text
    let entry = document.querySelector('.cover-empty-pill') || document.querySelector('.add-text');
    if (!entry) {
      // 已有封面：.edit-text 是 hover 才显示的「更换封面」，先 hover 再点
      const slot = document.querySelector('.cover-slot');
      if (slot) slot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      entry = document.querySelector('.edit-text');
      if (entry) logMsg('  已有封面 → 点「更换封面」重新上传');
    }
    if (!entry) {
      entry = [...document.querySelectorAll('div,span,a,button')].find((el) =>
        el.childElementCount === 0 && /^(添加封面|更换封面|编辑封面|上传封面|设置封面)$/.test(el.textContent.trim()));
    }
    if (!entry) { logMsg('  [WARN] 未找到封面入口'); return false; }
    realClick(entry);

    // 2. 等编辑器出现
    //    【实测】真实结构是 .bcc-dialog 里的 .cover-editor-content
    // 【提速】出现即走，不再固定 25×200ms 空转
    const editorOk = await waitFor(() => {
      const ce = document.querySelector('.cover-editor-content');
      return !!(ce && ce.closest('.bcc-dialog'));
    }, 2500, 80);
    if (!editorOk) {
      logMsg('  [WARN] 封面编辑器未出现');
      logMsg('  结构: ' + dumpNode(document.querySelector('[class*="dialog"]'), 3));
      return false;
    }
    logMsg('  封面编辑器已打开');

    // 3. 注入文件
    //    【实测】编辑器刚出现时上传框可能还没绑定，注入后要回读预览，没出来就重试
    let injected = false;
    for (let t = 0; t < 3 && !injected; t++) {
      const ce4 = document.querySelector('.cover-editor-content');
      const d4 = ce4 ? ce4.closest('.bcc-dialog') : null;
      const inp = d4 && (d4.querySelector('.bcc-upload-wrapper input[type="file"]')
        || d4.querySelector('input[type="file"][accept*="image"]'));
      if (inp) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          inp.files = dt.files;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (err) {
          logMsg('  [ERROR] 注入异常: ' + err.message);
        }
      } else if (t === 0) {
        logMsg('  [WARN] 编辑器内没有图片 file input');
        logMsg('  结构: ' + dumpNode(document.querySelector('.bcc-dialog'), 3));
      }
      // 【提速】预览一出现就走，不再每次固定睡 1300ms
      injected = await waitFor(() => {
        const ce5 = document.querySelector('.cover-editor-content');
        const d5 = ce5 ? ce5.closest('.bcc-dialog') : null;
        return !!(d5 && [...d5.querySelectorAll('img')].some((i) => (i.src || '').indexOf('blob:') === 0));
      }, 1000, 80);
      if (!injected) {
        logMsg('  第 ' + (t + 1) + ' 次注入没出预览，退避后重试');
        await backoffIfLimited();
        await delay(400);
      }
    }
    // 【关键】本地上传全程不查询、不等待 .cover-recommend-list / .ai-cover-list。
    // 之前 16:9 封面要等系统推荐帧的异步请求回来才能「确定」，就是被这条链拖住的。
    logMsg('  图片注入: ' + (injected ? '成功' : '失败（不等系统推荐帧，继续尝试确定）'));

    // 【新增】确认「双比例同步改动」开关是启用的 —— 否则 16:9 / 4:3 两张封面不一致时会卡在这里
    //    真实结构：.sync-checkbox-wrapper.ratio_4_3 / .ratio_16_9 里的 label.sync-checkbox.bcc-checkbox
    //    状态看 input.checked（注意 label 文本里的 "false" 是 Vue 变量，不是状态，别被误导）
    //    【修复】原来这里用了未定义的 dlg（setCover 里只有 ce4/d4）→ 严格模式直接 ReferenceError，
    //    整段封面流程崩掉。现在块内自己取，并且整块 try/catch：这一步只是辅助，绝不能拖垮封面。
    try {
      const ceSync = document.querySelector('.cover-editor-content');
      const dlgSync = ceSync ? ceSync.closest('.bcc-dialog') : null;
      const syncs = dlgSync
        ? [...dlgSync.querySelectorAll('.sync-checkbox-wrapper, .sync')]
          .filter((e) => e.getBoundingClientRect().width > 0 && /双比例同步/.test(e.textContent || ''))
        : [];
      for (const s of syncs) {
        const input = s.querySelector('input[type=checkbox]');
        const label = s.querySelector('.sync-checkbox') || s.querySelector('.bcc-checkbox') || s;
        const on = input ? !!input.checked : /bcc-checkbox-checked/.test(label.className || '');
        const tag = (s.className.match(/ratio_\d+_\d+/) || [''])[0];
        if (on) {
          logMsg('  双比例同步已启用（' + tag + '），跳过');
          continue;
        }
        logMsg('  双比例同步未启用（' + tag + '）→ 点击启用');
        realClick(label);
        await delay(350);
        const after = input ? !!input.checked : /bcc-checkbox-checked/.test((s.querySelector('.sync-checkbox') || s).className || '');
        if (!after) logMsg('  [WARN] 双比例同步点击后仍未启用');
      }
    } catch (e) {
      logMsg('  [WARN] 双比例同步检查跳过: ' + (e && e.message));
    }

    // 4. 点「完成」
    //    【实测】弹窗底部 .bcc-dialog__footer 里的「确定/取消」是 0x0 的隐藏节点，点了没用；
    //    真正生效的是 .cover-editor-button 里那颗可见的「完成」（.button.submit）
    let doneBtn = null;
    // 【提速 + 修复】按钮一可点就点；disabled 状态也纳入判定，避免点了没反应后白等
    await waitFor(() => {
      const ce6 = document.querySelector('.cover-editor-content');
      const d6 = ce6 ? ce6.closest('.bcc-dialog') : null;
      if (!d6) return false;
      doneBtn = [...d6.querySelectorAll('.cover-editor-button .button.submit, .button.submit, button, .bcc-button, div[class*="button"]')]
        .find((b) => {
          const r = b.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          if (!/^(完成|确定)$/.test((b.textContent || '').trim())) return false;
          return !(b.disabled || b.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(b.className || '')));
        }) || null;
      return !!doneBtn;
    }, 2500, 80);
    if (!doneBtn) {
      logMsg('  [WARN] 找不到可点的「完成」按钮（不等系统推荐帧）');
      logMsg('  结构: ' + dumpNode(document.querySelector('.bcc-dialog'), 3));
      return false;
    }
    logMsg('  点击「' + doneBtn.textContent.trim() + '」');
    realClick(doneBtn);

    // 5. 等 B站 收尾：封面位不再是「添加封面」才算成功
    // 【关键修复】16:9 横版封面填好后，.cover-empty-pill 可能是「另一个未填的槽」而一直存在；
    // 旧逻辑只等它消失 → 白等 30 秒再误判失败，看起来就像「16:9 不上传」。
    // 现在增加「主封面图 src 已变化」作为第二信号，任一满足即成功。
    const coverImg = () => document.querySelector('.cover-slot img, .cover-img img, .cover-container img, .cover-empty-pill img');
    const beforeSrc = (coverImg() || {}).src || '';
    const ok = await waitFor(() => {
      if (!document.querySelector('.cover-empty-pill')) return true;
      const im = coverImg();
      return !!(im && im.src && im.src !== beforeSrc);
    }, 4000, 100);
    logMsg('  封面结果: ' + (ok ? '已就位' : '未确认（记入自动重试，不等推荐帧）'));
    return ok;
  }

  // ==================================================
  // ↓↓↓ 【新增 3】标题沿用 / 系统推荐封面 / 封面池 ↓↓↓
  // ==================================================

  /** Vue 受控输入框赋值（普通 el.value= 不会触发 v-model） */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findTitleInput() {
    const sels = [
      'input[placeholder*="标题"]', 'textarea[placeholder*="标题"]',
      '.video-title input', '.video-title textarea',
      '.title-wrap input', '.title-container input', '.title-input input',
      '.bcc-input input.input-val', 'input.input-val',
    ];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (el.offsetParent !== null && !el.readOnly && !el.disabled) return el;
      }
    }
    for (const lb of document.querySelectorAll('label,span,div')) {
      if (lb.childElementCount !== 0 || lb.textContent.trim() !== '标题') continue;
      let box = lb.parentElement;
      for (let up = 0; up < 3 && box; up++) {
        const inp = box.querySelector('input:not([type="file"]),textarea');
        if (inp && inp.offsetParent !== null) return inp;
        box = box.parentElement;
      }
    }
    return null;
  }

  /** 标题 = 原视频文件名（去扩展名），可选清洗 */
  function titleForVideo(videoBase) {
    let t = String(videoBase || '').trim();
    if (stripTimestamp) {
      const s = t.replace(/[\s_\-·.]*(?:(?:19|20)\d{6}(?:\d{0,6})?)$/, '').trim();
      if (s) t = s;
    }
    if (underscoreToSpace) t = t.replace(/[_\uFF3F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return t.slice(0, 80);
  }

  /** 按模板生成标题：{name} = 原视频文件名（去扩展名）；留空 = 直接用原名 */
  function buildTitle(tpl, name) {
    const base = String(name || '');
    const t = String(tpl || '').trim();
    if (!t) return base;
    return t.replace(/\{name\}/g, base).replace(/\{原名\}/g, base);
  }

  async function setTitleFromFilename(text) {
    if (!text) return false;
    const input = findTitleInput();
    if (!input) { logMsg('  [WARN] 未找到标题输入框'); return false; }
    if ((input.value || '').trim() === text) {
      logMsg('  标题已是「' + text + '」，跳过');
      return true;
    }
    input.focus();
    setNativeValue(input, text);
    await delay(250);
    input.blur();
    logMsg('  标题 →「' + text + '」');
    return (input.value || '').trim() === text;
  }

  /** 用B站系统自动截取的推荐封面；idx=用第几张（0 基） */
  async function setCoverSystem(idx) {
    // ① 【实测】主页面就有「系统推荐封面」列表，直接点缩略图即可，不用打开编辑器
    // 【提速】出现即用，最多 2s；系统推荐只有显式选中才走，不拖累默认的按文件名匹配
    await waitFor(() => {
      const l = document.querySelector('.cover-recommend-list');
      return !!(l && l.querySelectorAll('.img-item-box').length);
    }, 2000, 100);
    const list = document.querySelector('.cover-recommend-list');
    if (list) {
      const items = [...list.querySelectorAll('.img-item-box')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (items.length) {
        const i = Math.min(Math.max(idx || 0, 0), items.length - 1);
        items[i].click();
        const ok = await waitFor(() => !document.querySelector('.cover-empty-pill'), 4000, 100);
        logMsg('  系统推荐封面 → 第 ' + (i + 1) + ' 张（共 ' + items.length + ' 张）' + (ok ? '' : '（未生效）'));
        if (ok) return true;
      }
    }

    // 【实测结论】已保存过的草稿，B站不再生成系统推荐帧；只有「第一次上传」才有。
    // 这类稿件不再打开封面编辑器空转（编辑器里 ai-cover-list 同样是空的），明确跳过。
    logMsg('  [提示] 本稿件无系统推荐帧（已保存草稿不再生成，仅首次上传才有）→ 封面保持原样');
    return false;

    // ② 兜底：主页面没有推荐列表时，才打开编辑器
    let entry = document.querySelector('.cover-empty-pill') || document.querySelector('.add-text') || document.querySelector('.edit-text');
    if (!entry) { logMsg('  [WARN] 未找到封面入口'); return false; }
    entry.click();

    let dlg = null;
    for (let i = 0; i < 25 && !dlg; i++) {
      const ce = document.querySelector('.cover-editor-content');
      dlg = ce ? ce.closest('.bcc-dialog') : null;
      if (!dlg) await delay(200);
    }
    if (!dlg) { logMsg('  [WARN] 封面编辑器未出现'); return false; }

    const cards = [...dlg.querySelectorAll('.ai-cover-list .card')].filter((c) => !c.classList.contains('card-clear'));
    if (!cards.length) {
      logMsg('  [WARN] 该视频暂无系统推荐帧（B站尚未生成/不支持），封面保持空');
      const cls = dlg.querySelector('.bcc-dialog-close, [class*="dialog-close"], [class*="close-icon"]');
      if (cls) cls.click(); else document.body.click();
      return false;
    }
    if (cards.length) {
      const i = Math.min(Math.max(idx || 0, 0), cards.length - 1);
      realClick(cards[i]);
      logMsg('  编辑器内系统封面 → 第 ' + (i + 1) + ' 张');
      await delay(700);
    }

    let doneBtn = null;
    for (let i = 0; i < 20 && !doneBtn; i++) {
      const ce7 = document.querySelector('.cover-editor-content');
      const d7 = ce7 ? ce7.closest('.bcc-dialog') : null;
      if (d7) {
        doneBtn = [...d7.querySelectorAll('.cover-editor-button .button.submit, .button.submit, button, .bcc-button')]
          .find((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && /^(完成|确定)$/.test((b.textContent || '').trim());
          }) || null;
      }
      if (!doneBtn) await delay(300);
    }
    if (!doneBtn) { logMsg('  [WARN] 找不到「完成」'); return false; }
    realClick(doneBtn);
    let ok2 = false;
    for (let i = 0; i < 40; i++) {
      await delay(400);
      if (!document.querySelector('.cover-empty-pill')) { ok2 = true; break; }
    }
    logMsg('  封面结果: ' + (ok2 ? '已就位' : '未生效'));
    return ok2;
  }

  /** 读图片真实像素尺寸（用来区分「同名但 16:9 / 4:3 是两张不同的图」） */
  function probeSize(file) {
    return new Promise((resolve) => {
      const u = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { resolve({ w: im.naturalWidth, h: im.naturalHeight }); URL.revokeObjectURL(u); };
      im.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(u); };
      im.src = u;
    });
  }

  /** 把一批文件加入封面池 */
  async function addCovers(files) {
    let n = 0;
    const pending = [];
    for (const f of files) {
      if (!/\.(jpe?g|png|bmp|webp)$/i.test(f.name)) continue;
      if (f.size > 8 * 1024 * 1024) { logMsg('[SKIP] 超过 8MB: ' + f.name); continue; }
      if (coverPool.some((c) => c.name === f.name && c.file.size === f.size)) continue;
      const rec = { id: 'c' + (coverPool.length + 1) + '_' + Date.now(), file: f, name: f.name, url: URL.createObjectURL(f), w: 0, h: 0 };
      coverPool.push(rec);
      pending.push(probeSize(f).then((s) => { rec.w = s.w; rec.h = s.h; }));
      n++;
    }
    await Promise.all(pending);
    buildMatch();
    renderMatch();
    const dup = {};
    coverPool.forEach((c) => { dup[c.name] = (dup[c.name] || 0) + 1; });
    const dupNames = Object.keys(dup).filter((k) => dup[k] > 1);
    logMsg('加入封面 ' + n + ' 张，共 ' + coverPool.length + ' 张' +
      (dupNames.length ? '（同名多图 ' + dupNames.length + ' 组：' + dupNames.slice(0, 5).join('、') + (dupNames.length > 5 ? '…' : '') + '）' : ''));
    notify('封面 ' + coverPool.length + ' 张', 'success');
  }

  function pickCovers(multiple) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/bmp,image/webp';
    input.multiple = !!multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = (e) => {
      const files = [...e.target.files];
      input.remove();
      if (files.length) addCovers(files);
    };
    input.click();
  }

  /** 选整个文件夹（webkitdirectory），按文件名自动配对 */
  function pickFolder() {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = (e) => {
      const all = [...e.target.files];
      input.remove();
      const imgs = all.filter((f) => /\.(jpe?g|png|bmp|webp)$/i.test(f.name));
      if (!imgs.length) { notify('文件夹里没有图片', 'warning'); return; }
      logMsg('文件夹共 ' + all.length + ' 个文件，图片 ' + imgs.length + ' 张');
      addCovers(imgs);
    };
    input.click();
  }

  function coverById(id) { return coverPool.find((c) => c.id === id) || null; }

  /** 生成 视频↔封面 映射（贪心一对一） */
  /**
   * 【修复】任务卡的「原始标题」只记一次。
   * 之前 buildMatch 每次都从 DOM 读当前标题，而 processSingleTask 是先设标题再设封面；
   * 标题一改（去时间戳 / 自定义模板），videoBase 就跟着变，跟封面文件名再也对不上 →
   * 全部匹配失败 → 跳过封面 → B站 自动塞「系统推荐帧」。这就是「封面变成系统推荐」的根因。
   */
  const taskRawTitle = new WeakMap();

  function buildMatch() {
    const tasks = getTasks();
    const used = {};
    const rows = [];
    tasks.forEach((el, i) => {
      let raw = taskRawTitle.get(el);
      if (!raw) {
        raw = getTaskTitle(el);
        if (raw) taskRawTitle.set(el, raw);
      }
      const vb = baseName(raw);
      let key = normName(vb) || ('idx' + i);
      if (used[key]) { used[key] += 1; key += '#' + used[key]; } else used[key] = 1;
      rows.push({ key, task: el, videoBase: vb, title: titleForVideo(vb), coverId: null, score: 0 });
    });

    // 手动改绑优先
    const manualCovers = new Set();
    rows.forEach((r) => {
      if (Object.prototype.hasOwnProperty.call(manualBind, r.key)) {
        r.coverId = manualBind[r.key] || null;
        r.score = r.coverId ? 1 : 0;
        if (r.coverId) manualCovers.add(r.coverId);
      }
    });

    if (coverMode === 'match') {
      // ① 第一轮：只认「原本文件名」完全一致（忽略扩展名 / 全角半角 / (1) 副本号）
      //    精确同名绝对优先，绝不会被近似匹配的图抢走
      //    【修复】不再用 taken 占位：B站 允许同一张封面用于多个稿件。
      //    之前 2 个同名视频只有 1 张同名图时，第二个会被判「未匹配」→ 跳过 → B站 塞系统推荐帧。
      rows.forEach((r) => {
        if (Object.prototype.hasOwnProperty.call(manualBind, r.key) || r.coverId) return;
        const want = normName(r.videoBase);
        if (!want) return;
        const cands = coverPool.filter((c) => !manualCovers.has(c.id) && normName(c.name) === want);
        if (!cands.length) return;
        // 同名多图（同一个名字存了 16:9 和 4:3 两张）→ B站封面位是 16:9，优先挑比例最接近 16:9 的那张
        cands.sort((x, y) => {
          const rx = (x.w && x.h) ? Math.abs(x.w / x.h - 16 / 9) : 9;
          const ry = (y.w && y.h) ? Math.abs(y.w / y.h - 16 / 9) : 9;
          return rx - ry;
        });
        const hit = cands[0];
        r.coverId = hit.id; r.score = 1; r.exact = true;
        if (cands.length > 1) logMsg('  [同名 ' + cands.length + ' 张] 选 ' + hit.name + '（' + (hit.w || '?') + '×' + (hit.h || '?') + '）');
      });
      // ② 【已取消相似度兜底】实测「课程 第01讲」和「课程 第02讲」这类同系列文件名，
      //    相似度会超过任何合理阈值，结果是凑一张看起来像的图贴上去 —— 正是串图的根源。
      //    现在只认原名精确，配不上就标「未匹配」，由面板下拉手动改绑。
    }

    // 绑定到元素本身：DOM 重排时也不会把 A 的封面贴到 B 上
    rows.forEach((r) => { if (r.task) taskRowBind.set(r.task, r); });
    matchMap = rows;
    return rows;
  }

  function renderMatch() {
    const box = document.getElementById('bili-batch-match');
    if (!box) return;
    if (!matchMap.length) {
      box.innerHTML = '<div style="color:#bbb;text-align:center;padding:8px;font-size:11px;">还没检测到视频任务</div>';
      return;
    }
    box.innerHTML = matchMap.map((r) => {
      const c = coverById(r.coverId);
      let tag = '';
      if (coverMode === 'system') tag = '<span style="color:#1890ff;">系统</span>';
      else if (coverMode === 'none') tag = '<span style="color:#bbb;">不设</span>';
      else if (c) tag = '<span style="color:#52c41a;">' + (r.manual || (r.exact ? '原名✓' : '近似' + Math.round((r.score || 0) * 100) + '%')) + '</span>';
      else tag = '<span style="color:#ff4d4f;">未匹配</span>';

      const sel = coverMode === 'match'
        ? '<select class="bb-bind" data-key="' + r.key + '" style="width:100%;font-size:11px;padding:1px;">' +
          '<option value="">（不设封面）</option>' +
          coverPool.map((x) => '<option value="' + x.id + '"' + (x.id === r.coverId ? ' selected' : '') + '>' +
            (x.name.length > 24 ? x.name.slice(0, 22) + '…' : x.name) + '</option>').join('') +
          '</select>'
        : '';

      return '<div style="display:flex;gap:6px;padding:4px 0;border-bottom:1px dashed #eee;">' +
        '<div style="width:44px;height:28px;flex:0 0 44px;background:#f2f2f2;border-radius:3px;overflow:hidden;">' +
        (c ? '<img src="' + c.url + '" style="width:100%;height:100%;object-fit:cover;">' : '') + '</div>' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:11px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        tag + ' ' + r.videoBase.replace(/</g, '&lt;') + '</div>' +
        (c ? '<div style="font-size:10px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + c.name.replace(/</g, '&lt;') + '（' + (c.w ? c.w + '×' + c.h : '读取中') + '）</div>' : '') + sel +
        '</div></div>';
    }).join('');
  }
  // ↑↑↑ 【新增 3】↑↑↑

  /** 设置分区
   *  【实测】当前分区显示在 .select-item-cont-inserted（例如「汽车」）；
   *          .selector-container 点下去并没有可见下拉/弹窗，所以「改成别的分区」目前做不到。
   *          这里只做两件事：① 已经是目标分区就跳过；② 没填目标就不动。
   */
  async function setCategoryIfNeeded(target) {
    const want = (target || '').trim();
    const curEl = document.querySelector('.select-item-cont-inserted');
    const cur = curEl ? curEl.textContent.trim() : '';

    if (!want) { logMsg('  分区: 未指定，保持不变（当前：' + (cur || '未知') + '）'); return true; }
    if (cur && cur.indexOf(want) !== -1) { logMsg('  分区已是「' + cur + '」，跳过'); return true; }

    // 尝试打开下拉（实测多数情况下打不开）
    const sel = document.querySelector('.selector-container');
    if (!sel) { logMsg('  [WARN] 未找到分区选择器'); return false; }
    sel.click();
    await delay(800);

    const visOpt = [...document.querySelectorAll('li, [class*="option-item"], [class*="select-item"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (el.textContent || '').trim() === want;
      })[0];

    if (visOpt) {
      visOpt.click();
      await delay(500);
      logMsg('  分区 →「' + want + '」');
      return true;
    }

    logMsg('  [WARN] 分区下拉没打开/没有「' + want + '」，保持当前「' + (cur || '未知') + '」');
    return false;
  }

  // ===========================
  // 批量处理主流程
  // ===========================

  /**
   * 【修复】关掉 B站 的「批量上传提示」弹窗。
   * 实测：任务数 >1 时它会自动弹出（内容：批量上传将生成多条动态，打扰粉丝…去试试/暂不设置），
   * 盖住整个页面，导致合集下拉虽然打开了却点不到 → 看起来像「合集没自动选」。
   */
  async function dismissBatchDialog() {
    // 页面上可能有多个 .bcc-dialog（如「关闭确认」），必须逐个找那个带「暂不设置」的
    const dialogs = [...document.querySelectorAll('.batch-dialog, .bcc-dialog')];
    for (const dlg of dialogs) {
      const r0 = dlg.getBoundingClientRect();
      if (!r0.width && !r0.height) continue;      // fixed 元素 offsetParent 恒为 null，只能靠 rect 判可见
      const btns = [...dlg.querySelectorAll('button, span, a')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (e.textContent || '').trim().length <= 8;
      });
      const no = btns.find((e) => /暂不设置|暂不|跳过/.test((e.textContent || '').trim()));
      if (!no) continue;
      no.click();
      logMsg('[弹窗] 已关闭「批量上传提示」（暂不设置）');
      await delay(500);
      return true;
    }
    return false;
  }

  /**
   * 【新增】加入合集。实测（2026-11-16，已开通 Lv2 的账号）：
   *   .video-season → .season-enter（假下拉，文案“请选择合集”）
   *   点开后弹层就在同一个 .video-season 里：.season-list.season-dropdown
   *   选项 = .season-item > .season-item-title；另有 .season-add「创建合集」
   * 未开通（未达权益中心 Lv2）时只有 .video-season-tip 提示文字、没有下拉，直接跳过。
   */
  async function setSeason(task, seasonName) {
    await dismissBatchDialog();   // 先关掉会遮挡的「批量上传提示」弹窗
    // 实测：合集控件在右侧表单 .form 里，不在 .task 任务卡内；页面可能有多个副本，取可见的那个
    const boxes = [...document.querySelectorAll('.video-season')].filter((e) => e.offsetParent !== null);
    const box = boxes[0] || (task ? task.querySelector('.video-season') : null);
    if (!box) { logMsg('[合集] 未找到「加入合集」区域'); return false; }
    const tip = box.querySelector('.video-season-tip');
    if (tip && /Lv2|开通|满足/.test(tip.textContent)) {
      logMsg('[合集] 账号未开通合集功能（需权益中心等级 Lv2），跳过');
      return false;
    }
    const enter = box.querySelector('.season-enter');
    if (!enter) { logMsg('[合集] 没有合集下拉（可能未开通）'); return false; }
    if (!seasonName) { logMsg('[合集] 没填合集名，跳过'); return false; }

    const current = enter.querySelector('.season-enter-text-default')
      ? '' : (enter.textContent || '').trim();
    if (current === seasonName) { logMsg('[合集] 已经是「' + seasonName + '」，跳过'); return true; }

    enter.click();
    await delay(350);
    await dismissBatchDialog();   // 弹窗可能又被弹出来，盖住下拉
    try { await waitFor(() => box.querySelector('.season-list.season-dropdown'), 4000, 120); } catch (e) { /* 下面统一判 */ }
    const list = box.querySelector('.season-list.season-dropdown');
    if (!list) { logMsg('[合集] 下拉没弹出来'); return false; }

    const items = [...list.querySelectorAll('.season-item')];
    const names = items.map((it) => {
      const t = it.querySelector('.season-item-title');
      return (t ? t.textContent : it.textContent).trim();
    });
    // 把已有合集写进 datalist，下次可以直接选
    const dl = document.getElementById('bb-season-list');
    if (dl && names.length) {
      dl.innerHTML = names.map((n) => '<option value="' + escapeHtml(n) + '"></option>').join('');
    }

    const idx = names.indexOf(seasonName);
    if (idx < 0) {
      logMsg('[合集] 没有名为「' + seasonName + '」的合集。现有: ' + names.join('、'));
      enter.click();
      return false;
    }
    items[idx].click();
    await delay(450);
    const done = (enter.textContent || '').indexOf(seasonName) >= 0;
    logMsg('[合集] ' + (done ? '已加入「' + seasonName + '」' : '点了但没确认到「' + seasonName + '」'));
    return done;
  }

  async function processSingleTask(task, file, index, total, row) {
    const title = (row && row.videoBase) || task.getAttribute('title') || ('任务 #' + (index + 1));
    let coverOk = true;   // 【新增】把封面成败回传主流程，供失败项自动重试
    logMsg(`[${index + 1}/${total}] 处理「${title}」...`);

    // 1. 选中任务
    logMsg('  选中任务...');
    selectTask(task);
    // 提速：等到表单真的渲染好（最多 2s），而不是死等
    await waitFor(findTitleInput, 1500, 80);

    // 【新增】标题沿用原视频文件名
    if (runOpts.title && row) {
      const nm = row.title || row.videoBase || '';
      const keep = autoUp.running ? (autoSettings.keepName !== false) : titleFromName;   // 保留原名（默认）
      const tpl = autoUp.running ? autoSettings.titleTpl : titleTpl;
      if (keep) {
        await setTitleFromFilename(nm);                     // 保留原名上传（默认）
      } else if (tpl && tpl.trim()) {
        await setTitleFromFilename(buildTitle(tpl, nm));    // 自定义标题
      } else if (nm) {
        await setTitleFromFilename(nm);                     // 没填模板也用原名兜底
      }
    }

    // 2. 创作声明
    if (runOpts.declaration) await setDeclaration(CONFIG.DECLARATION_TEXT);

    // 3. 可见范围
    if (runOpts.privacy) await setPrivacy(privacyWant);

    // 【新增】在个人空间-投稿中隐藏
    if (runOpts.spaceHide) await setSpaceHide(true);   // 【修复】不再要求两个勾同时开

    // 【新增】更多设置里的复选框（默认不勾，需要时在面板打开）
    if (runOpts.watermark) await setCheckboxByLabel('添加水印', true);
    if (runOpts.danmaku) await setCheckboxByLabel('关闭弹幕', true);
    if (runOpts.comment) await setCheckboxByLabel('关闭评论', true);
    if (runOpts.featured) await setCheckboxByLabel('开启精选评论', true);

    // 【新增】简介 / 粉丝动态（富文本）
    if (introText) await setQuillText('.desc-container', introText);
    if (fanText) await setQuillText('.daynamic-label', fanText);

    // 【新增】定时发布 / 二创 / 杜比 / Hi-Res
    if (runOpts.schedule) await setSchedule(true);
    if (runOpts.erchuang) await setToggleByText_row('二创', true);
    if (runOpts.dolby) await setToggleByText_row('杜比音效', true);
    if (runOpts.hires) await setToggleByText_row('Hi-Res', true);
    if (runOpts.season) {
      const se = document.getElementById('bb-season');
      const sn = (se && se.value.trim()) || autoSettings.season || '';   // 兜底：全局没设就用自动上传的
      await setSeason(task, sn);
    }
    // 不生成动态（页面表单里的完整文案是「此稿件不生成更新推送」）
    if (runOpts.nodyn) await setCheckboxByLabel('此稿件不生成更新推送', true);

    // 4. 分区（如果还不是绘画）
    if (runOpts.category) await setCategoryIfNeeded(categoryWant);

    // 5. 标签
    if (runOpts.tags) await setTagsAuto();

    // 6. 封面 —— 【定稿】只按视频原本文件名匹配本地图片
    //    删掉「系统推荐帧不可用 → 回退上传一张固定单图」：这就是「卒之揾咗张图片掉上去」的来源
    if (skipCoverThisRun) {
      logMsg('  封面: 本次未选封面 → 跳过封面，其它项目已设置');
    } else if (!runOpts.cover || coverMode === 'none') {
      logMsg('  封面: 未勾选/本次不设，跳过');
    } else if (coverMode === 'system') {
      coverOk = await setCoverSystem(systemFrame);
      if (!coverOk) logMsg('  本稿件无系统推荐帧 → 跳过（不再回退单图）');
    } else if (coverMode === 'single' && selectedCoverFile) {
      logMsg('  全部同一张 → ' + selectedCoverFile.name);
      coverOk = await setCoverWithBackoff(selectedCoverFile);
    } else {
      const c = coverById(row && row.coverId);
      if (c) {
        logMsg('  按文件名匹配 → ' + c.file.name);
        coverOk = await setCoverWithBackoff(c.file);
      } else {
        coverOk = false;
        logMsg('  [WARN] 该行没匹配到封面（不用单图兜底）');
      }
    }
    await backoffIfLimited();   // 这一项跑完若已被限流，先退避再做下一项
    if (coverOk && row && row.videoBase) markCoverDone(row.videoBase);   // 重试一轮时排除
    return coverOk;   // 交回主流程：false 的项目会自动重试
  }

  /** 自定义标签：写进「按回车键Enter创建标签」输入框并回车 */
  async function setCustomTags(text) {
    const inp = [...document.querySelectorAll('input[placeholder*="标签"]')]
      .find((e) => e.offsetParent !== null);
    if (!inp) { logMsg('  [WARN] 没找到标签输入框'); return false; }
    const tags = text.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
    let n = 0;
    for (const t of tags) {
      inp.focus();
      inp.value = t;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await delay(180); n++;
    }
    logMsg('  自定义标签 → ' + tags.join(' / ') + '（' + n + ' 个）');
    return n > 0;
  }

  /** 空间隐藏：开 / 关 两个按钮共用 */
  async function processSpaceHideToggle(on) {
    const tasks = getTasks();
    if (!tasks.length) { notify('未找到视频任务', 'error'); return; }
    processing = true; abortFlag = false; disableButtons(true);
    let ok = 0, fail = 0;
    logMsg('==== 批量空间隐藏 → ' + (on ? '开' : '关') + ' ====');
    try {
      for (let i = 0; i < tasks.length && !abortFlag; i++) {
      if (!isCurrentInstance()) { abortFlag = true; break; }   // 被新实例接管，旧实例退出
        selectTask(tasks[i]); await waitFor(() => !!document.querySelector('input[placeholder*="标题"], .bcc-select-input-inner, .check-radio-v2-container'), 800, 60);
        (await setSpaceHide(on)) ? ok++ : fail++;
        await delay(60);
      }
    } catch (e) { logMsg('  [ERROR] ' + e.message); }
    finally {
      processing = false; disableButtons(false); hideProgress();
      logMsg('==== 空间隐藏结束：成功 ' + ok + '，失败 ' + fail + ' ====');
      notify('空间隐藏: 成功' + ok + ', 失败' + fail, fail > 0 ? 'warning' : 'success');
    }
  }

  /** 【新增】一键：对每一项「设置完 → 立刻投稿 → 再下一项」
   *  注意：投稿成功后该任务会从列表消失，所以永远取「当前第一项」 */
  async function processAllThenSubmit() {
    if (processing) { notify('正在处理中...', 'warning'); return; }

    const tasks0 = getTasks();
    if (!tasks0.length) { notify('未找到视频任务', 'error'); return; }

    if (!confirm('将对全部 ' + tasks0.length + ' 个视频逐项执行：\n\n' +
      '① 设置（标题 / 封面 / 声明 / 可见范围 / 分区 / 标签 / 空间隐藏）\n' +
      '② 立刻「立即投稿」这一项\n' +
      '③ 再处理下一项\n\n' +
      '投稿不可撤销，视频会真正发布。确定继续？')) return;

    processing = true;
    abortFlag = false;
    disableButtons(true);

    const total = tasks0.length;
    let ok = 0, fail = 0, done = 0;
    let lastKey = '';
    let stuck = 0;

    if (waitUploadDone && countUploading() > 0) {
      logMsg('==== 检测到还有视频没上传完，先等 ====');
      await waitAllUploaded(60);
      if (abortFlag) { processing = false; disableButtons(false); hideProgress(); return; }
    }

    logMsg('==== 逐项：设置 → 立即投稿（共 ' + total + ' 个）====');
    showProgress(0, total, '0 / ' + total);

    while (!abortFlag) {
      const tasks = getTasks();
      if (!tasks.length) break;

      const task = tasks[0];
      const key = getTaskTitle(task);
      if (key === lastKey) { stuck++; } else { stuck = 0; lastKey = key; }
      if (stuck > 2) {
        logMsg('  [STOP] 连续 3 次没能投出「' + key + '」，已停止，避免死循环');
        break;
      }

      done++;
      const rows = buildMatch();
      const row = rows[0] || null;
      const name = row ? row.videoBase : key;
      logMsg('[' + done + '/' + total + '] ' + name);
      showProgress(done, total, done + ' / ' + total + ' — ' + escapeHtml(name).slice(0, 20));

      try {
        // ① 这一项的全部设置
        await processSingleTask(task, selectedCoverFile, done - 1, total, row);

        // ② 立刻投稿
        selectTask(task);
        await delay(300);
        const submitBtn = document.querySelector('.submit-add');
        if (!submitBtn) throw new Error('未找到「立即投稿」按钮');
        submitBtn.click();

        // 等它从列表消失，再进入下一项
        const before = getTasks().length;
        let gone = false;
        for (let i = 0; i < 40; i++) {
          await delay(500);
          if (getTasks().length < before) { gone = true; break; }
        }
        ok++;
        markSubmitted(name);          // 本地立即记账（接口落库有延迟，不等它）
        fillSubmittedIds(name);       // 异步补 bvid/aid
        logMsg('  已投稿' + (gone ? '' : '（列表没刷新，继续）'));
      } catch (err) {
        fail++;
        logMsg('  [FAIL] ' + (err && err.message ? err.message : err));
      }

      if (!abortFlag) await delay(400);
    }

    processing = false;
    disableButtons(false);
    hideProgress();
    const aborted = abortFlag;
    const tail = '成功 ' + ok + '，失败 ' + fail;
    if (aborted) {
      logMsg('==== 逐项投稿已中止（不是完成）：' + tail + ' ====');
      notify('已中止（不是完成）: ' + tail, 'warning');
    } else {
      logMsg('==== 逐项投稿完成: ' + tail + ' ====');
      notify('逐项投稿完成: 成功 ' + ok + ', 失败 ' + fail, fail > 0 ? 'warning' : 'success');
    }
  }

  async function processAllTasks() {
    if (processing) { notify('正在处理中...', 'warning'); return; }

    updateStats();
    const tasks = getTasks();
    if (tasks.length === 0) { notify('未找到视频任务', 'error'); return; }

    buildMatch();
    renderMatch();
    const ex = matchMap.filter((r) => r.coverId).length;
    const miss = matchMap.filter((r) => !r.coverId).length;
    logMsg('[匹配] 原名精确 ' + ex + ' / 未匹配 ' + miss + '（只认原文件名，不做相似度猜测）');
    matchMap.slice(0, 20).forEach((r) => {
      const c = coverById(r.coverId);
      logMsg('  ' + (c ? '✓ ' : '✗ ') + r.videoBase + ' → ' + (c ? c.name : '未匹配（面板下拉可手动绑）'));
    });
    if (matchMap.length > 20) logMsg('  …另 ' + (matchMap.length - 20) + ' 条省略');

    // 【修复】没选封面不再整体 return，只是跳过封面，其它项照常设置
    skipCoverThisRun =
      (coverMode === 'match'  && coverPool.length === 0 && !selectedCoverFile) ||
      (coverMode === 'single' && !selectedCoverFile);
    if (skipCoverThisRun) {
      logMsg('[提示] 未选封面 → 本次自动跳过封面，声明/可见范围/标签等照常设置');
    }

    await dismissBatchDialog();   // 处理前先清掉会遮挡的弹窗
    logMsg('==== 一键全部设置开始：' + tasks.length + ' 个视频，可见范围=' + privacyWant + '，封面模式=' + coverMode + ' ====');
    processing = true;
    abortFlag = false;
    disableButtons(true);
    let ok = 0, fail = 0;

    try {
      if (waitUploadDone && countUploading() > 0) {
        logMsg('==== 等待全部上传完成（最多 2 分钟）====');
        await waitAllUploaded(2);
        if (abortFlag) { logMsg('用户中止'); }
      }

      showProgress(0, tasks.length, '0 / ' + tasks.length);
      // 【一次性搞掂】失败项自动重试一轮，只补没成功的，不重跑已成功的
      let pending = tasks.map((_, i) => i);
      for (let round = 0; round < 2 && pending.length && !abortFlag; round++) {
        if (round) logMsg('==== 自动重试：上轮未成功的 ' + pending.length + ' 项（只补这些）====');
        const left = [];
        for (const i of pending) {
          if (abortFlag) break;
          const cur = i + 1;
          const row = taskRowBind.get(tasks[i]) || matchMap[i];
          showProgress(cur, tasks.length, (round ? '补 ' : '') + cur + ' / ' + tasks.length + ' — ' + escapeHtml((row && row.videoBase) || ''));
          try {
            const r = await processSingleTask(tasks[i], selectedCoverFile, i, tasks.length, row);
            if (r === false) { left.push(i); logMsg('  [RETRY] 封面未就位，稍后自动重试'); }
            else { ok++; logMsg('  [OK]'); }
          } catch (err) {
            left.push(i);
            logMsg('  [RETRY] ' + (err && err.message ? err.message : err));
          }
          if (!abortFlag) {
            await backoffIfLimited();          // 【限流】B站提示"请求频率过高"就自动停一停
            await delay(CONFIG.DELAY_BETWEEN_TASKS);
          }
        }
        pending = left;
      }
      fail = pending.length;
      if (fail) logMsg('  仍未成功：' + pending.map((i) => (matchMap[i] && matchMap[i].videoBase) || ('#' + (i + 1))).join('、'));
    } catch (err) {
      fail++;
      logMsg('  [ERROR] 一键流程异常: ' + (err && err.message ? err.message : err));
    } finally {
      // 【修复】无论成功/异常/中止，一定把按钮放出来，不会永久灰掉
      processing = false;
      skipCoverThisRun = false;
      disableButtons(false);
      hideProgress();
      const aborted = abortFlag;
      const tail = '成功 ' + ok + '，失败 ' + fail;
      if (aborted) {
        logMsg('==== 一键全部设置已中止（不是完成）：' + tail + ' ====');
        notify('已中止（不是完成）: ' + tail, 'warning');
      } else {
        logMsg('==== 一键全部设置结束：' + tail + ' ====');
        notify('完成: 成功 ' + ok + ', 失败 ' + fail, fail > 0 ? 'warning' : 'success');
      }
    }
  }

  // ===========================
  // 单项操作入口
  // ===========================

  async function processDeclarationOnly() {
    updateStats();
    const tasks = getTasks();
    if (tasks.length === 0) { notify('未找到视频任务', 'error'); return; }
    processing = true; abortFlag = false; disableButtons(true);
    let ok = 0, fail = 0;
    logMsg('==== 仅设置创作声明 ====');
    for (let i = 0; i < tasks.length && !abortFlag; i++) {
      if (!isCurrentInstance()) { abortFlag = true; break; }   // 被新实例接管，旧实例退出
      showProgress(i + 1, tasks.length, (i + 1) + '/' + tasks.length);
      selectTask(tasks[i]); await waitFor(() => !!document.querySelector('input[placeholder*="标题"], .bcc-select-input-inner, .check-radio-v2-container'), 800, 60);
      (await setDeclaration(CONFIG.DECLARATION_TEXT)) ? ok++ : fail++;
      if (i < tasks.length - 1) await delay(CONFIG.DELAY_BETWEEN_TASKS);
    }
    processing = false; disableButtons(false); hideProgress();
    notify('创作声明: 成功' + ok + ', 失败' + fail, fail > 0 ? 'warning' : 'success');
  }

  async function processPrivacyOnly() {
    updateStats();
    const tasks = getTasks();
    if (tasks.length === 0) { notify('未找到视频任务', 'error'); return; }
    processing = true; abortFlag = false; disableButtons(true);
    let ok = 0, fail = 0;
    logMsg('==== 仅设置可见范围 ====');
    for (let i = 0; i < tasks.length && !abortFlag; i++) {
      if (!isCurrentInstance()) { abortFlag = true; break; }   // 被新实例接管，旧实例退出
      showProgress(i + 1, tasks.length, (i + 1) + '/' + tasks.length);
      selectTask(tasks[i]); await waitFor(() => !!document.querySelector('input[placeholder*="标题"], .bcc-select-input-inner, .check-radio-v2-container'), 800, 60);
      (await setPrivacy(privacyWant)) ? ok++ : fail++;
      if (i < tasks.length - 1) await delay(CONFIG.DELAY_BETWEEN_TASKS);
    }
    processing = false; disableButtons(false); hideProgress();
    notify('可见范围: 成功' + ok + ', 失败' + fail, fail > 0 ? 'warning' : 'success');
  }

  async function processTagsOnly() {
    updateStats();
    const tasks = getTasks();
    if (tasks.length === 0) { notify('未找到视频任务', 'error'); return; }
    processing = true; abortFlag = false; disableButtons(true);
    let ok = 0, fail = 0;
    logMsg('==== 仅设置标签 ====');
    for (let i = 0; i < tasks.length && !abortFlag; i++) {
      if (!isCurrentInstance()) { abortFlag = true; break; }   // 被新实例接管，旧实例退出
      showProgress(i + 1, tasks.length, (i + 1) + '/' + tasks.length);
      selectTask(tasks[i]); await waitFor(() => !!document.querySelector('input[placeholder*="标题"], .bcc-select-input-inner, .check-radio-v2-container'), 800, 60);
      (await setTagsAuto()) ? ok++ : fail++;
      if (i < tasks.length - 1) await delay(CONFIG.DELAY_BETWEEN_TASKS);
    }
    processing = false; disableButtons(false); hideProgress();
    notify('标签: 成功' + ok + ', 失败' + fail, fail > 0 ? 'warning' : 'success');
  }

  // ===========================
  // 独立功能：批量立即投稿
  // （完全独立，与「一键全部设置」无关）
  // ===========================

  // ===== 【新增】剩下几项的写死实现 =====

  /** 富文本（Quill）写入：简介 / 粉丝动态 都是 .ql-editor */
  async function setQuillText(scopeSel, text) {
    const ed = document.querySelector(scopeSel + ' .ql-editor');
    if (!ed) { logMsg('  [WARN] 没找到富文本编辑器 ' + scopeSel); return false; }
    if (!text) return true;

    ed.focus();
    // 全选后插入，避免叠加
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }

    if (!ok || (ed.innerText || '').trim() !== text.trim()) {
      ed.innerHTML = '<p>' + text.replace(/[<>]/g, '') + '</p>';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await delay(200);
    const now = (ed.innerText || '').trim();
    logMsg('  ' + scopeSel + ' →「' + now.slice(0, 20) + '」' + (now === text.trim() ? '' : '（未确认）'));
    return now === text.trim();
  }

  /** 定时发布：.time-container 里的 .switch-container */
  async function setSchedule(on) {
    const box = document.querySelector('.time-container');
    if (!box) { logMsg('  [WARN] 没找到定时发布'); return false; }
    const sw = box.querySelector('.switch-container');
    if (!sw) { logMsg('  [WARN] 定时发布没有开关'); return false; }
    const isOn = /switch-container-active/.test(sw.className);
    if (isOn === !!on) { logMsg('  定时发布已是' + (on ? '开' : '关') + '，跳过'); return true; }
    sw.click();
    await delay(400);
    const now = /switch-container-active/.test(sw.className);
    logMsg('  定时发布 → ' + (now ? '开' : '关') + (now === !!on ? '' : '（未生效）'));
    return now === !!on;
  }

  /** 按「行内包含某段文字」找该行的开关/复选框（二创、杜比、Hi-Res） */
  async function setToggleByText_row(text, on) {
    const rows = [...document.querySelectorAll('.setting-label, .setting-card-body, .video-setting-card, .setting-content')];
    const row = rows.find((r) => (r.innerText || '').indexOf(text) !== -1 && r.querySelector('.switch-container, .bcc-checkbox'));
    if (!row) { logMsg('  [WARN] 没找到「' + text + '」的开关'); return false; }

    const sw = row.querySelector('.switch-container');
    if (sw) {
      const isOn = /switch-container-active/.test(sw.className);
      if (isOn === !!on) { logMsg('  「' + text + '」已是' + (on ? '开' : '关')); return true; }
      sw.click();
      await delay(350);
      const now = /switch-container-active/.test(sw.className);
      logMsg('  「' + text + '」→ ' + (now ? '开' : '关') + (now === !!on ? '' : '（未生效）'));
      return now === !!on;
    }

    const box = row.querySelector('.bcc-checkbox');
    if (box) {
      const inp = box.querySelector('input[type=checkbox]');
      const getS = () => (inp ? inp.checked : /checked/.test(box.className));
      if (getS() === !!on) { logMsg('  「' + text + '」已是' + (on ? '勾选' : '取消')); return true; }
      box.click();
      await delay(300);
      const now = getS();
      logMsg('  「' + text + '」→ ' + (now ? '勾选' : '取消') + (now === !!on ? '' : '（未生效）'));
      return now === !!on;
    }
    return false;
  }

  /** 【新增】在个人空间-投稿中隐藏
   *  实测：投稿页「更多设置」里 .setting-label-title 的文字「在个人空间-投稿中隐藏」，
   *        同一张卡片里的 .switch-container，开 = 多一个 switch-container-active */
  async function setSpaceHide(on) {
    const label = [...document.querySelectorAll('.setting-label-title')]
      .find((el) => /在个人空间/.test(el.textContent || ''));
    if (!label) { logMsg('  [WARN] 未找到「在个人空间-投稿中隐藏」开关'); return false; }

    const card = label.closest('.setting-card-body') || label.closest('.setting-content') || label.parentElement;
    const sw = card && card.querySelector('.switch-container');
    if (!sw) { logMsg('  [WARN] 未找到开关元素'); return false; }

    const isOn = /switch-container-active/.test(sw.className);
    if (isOn === !!on) {
      logMsg('  「在个人空间投稿中隐藏」已是' + (on ? '开' : '关') + '，跳过');
      return true;
    }
    sw.click();
    await delay(400);
    const nowOn = /switch-container-active/.test(sw.className);
    logMsg('  「在个人空间投稿中隐藏」→ ' + (nowOn ? '开' : '关') + (nowOn === !!on ? '' : '（未生效）'));
    return nowOn === !!on;
  }

  /** 【新增】按文字找设置行里的复选框，勾上/取消（关闭弹幕、关闭评论、开启精选评论、添加水印） */
  async function setCheckboxByLabel(labelText, on) {
    const leaves = [...document.querySelectorAll('span,div,label,p')]
      .filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === labelText);
    const lab = leaves.find((e) => e.offsetParent !== null) || leaves[0];
    if (!lab) { logMsg('  [WARN] 未找到「' + labelText + '」'); return false; }

    const row = lab.closest('.setting-label, .video-setting-card, .setting-card, .setting-card-body') || lab.parentElement;
    // 注意：label 文本的父元素常常就是 .bcc-checkbox 本身，querySelector 只搜后代不含自身，得先用 closest
    let box = lab.closest('.bcc-checkbox');
    if (!box && row) box = row.querySelector('.bcc-checkbox');
    if (!box) { logMsg('  [WARN]「' + labelText + '」没有复选框'); return false; }

    const getState = () => {
      const inp = box.querySelector('input[type=checkbox]');
      return inp ? inp.checked : /checked/.test(box.className);
    };
    if (getState() !== !!on) { box.click(); await delay(220); }
    const after = getState();
    logMsg('  「' + labelText + '」→ ' + (after ? '勾选' : '取消') + (after === !!on ? '' : '（未生效）'));
    return after === !!on;
  }

  /** 【新增】批量：在个人空间-投稿中隐藏（逐个任务拨开关） */
  async function processSpaceHideOnly() {
    if (processing) { notify('正在处理中...', 'warning'); return; }

    updateStats();
    const tasks = getTasks();
    if (!tasks.length) { notify('未找到视频任务', 'error'); return; }

    processing = true;
    abortFlag = false;
    disableButtons(true);

    let ok = 0, fail = 0;
    const total = tasks.length;
    logMsg('==== 批量：在个人空间-投稿中隐藏（共 ' + total + ' 个）====');
    showProgress(0, total, '0 / ' + total);

    for (let i = 0; i < total && !abortFlag; i++) {
      const t = tasks[i];
      const name = getTaskTitle(t);
      showProgress(i + 1, total, (i + 1) + ' / ' + total + ' — ' + escapeHtml(name).slice(0, 24));
      logMsg('[' + (i + 1) + '/' + total + '] ' + name);
      try {
        selectTask(t);
        await delay(CONFIG.DELAY_AFTER_CLICK);
        (await setSpaceHide(true)) ? ok++ : fail++;
      } catch (err) {
        fail++;
        logMsg('  [FAIL] ' + (err && err.message ? err.message : err));
      }
      if (i < total - 1 && !abortFlag) await delay(250);
    }

    processing = false;
    disableButtons(false);
    hideProgress();
    const msg = '空间隐藏: 成功 ' + ok + '，失败 ' + fail;
    logMsg('==== ' + msg + ' ====');
    notify(msg, fail > 0 ? 'warning' : 'success');
  }

  async function processBatchSubmit(skipConfirm) {
    if (processing) { notify('正在处理中...', 'warning'); return; }

    updateStats();
    const tasks = getTasks();
    if (tasks.length === 0) { notify('未找到视频任务', 'error'); return; }

    // 确认弹窗 — 这是不可逆操作
    if (!skipConfirm && !confirm('确定要批量立即投稿全部 ' + tasks.length + ' 个视频吗？\n\n' +
                 '此操作不可撤销，视频发布后将在你的个人主页中显示。\n\n' +
                 '建议先确认分区/声明/标签/封面/仅自己可见已设置好。尤其是仅自己可见。')) {
      return;
    }

    processing = true;
    abortFlag = false;
    disableButtons(true);

    let ok = 0, fail = 0;
    let total = tasks.length;
    let cur = 0;

    logMsg('==== 批量立即投稿 (共 ' + total + ' 个) ====');
    notify('开始批量立即投稿，共 ' + total + ' 个', 'info');
    showProgress(0, total, '0 / ' + total);

    // 每轮重新查询 DOM，始终投当前列表里的第一个
    while (!abortFlag) {
      const remaining = getTasks();
      if (remaining.length === 0) break;

      const task = remaining[0]; // 始终取第一个
      cur++;
      const title = task.getAttribute('title') || ('任务 #' + cur);
      showProgress(cur, total, cur + ' / ' + total + ' — ' + escapeHtml(title));
      logMsg('[' + cur + '/' + total + '] 投稿「' + title + '」...');

      try {
        selectTask(task);
        await delay(CONFIG.DELAY_AFTER_CLICK);

        const submitBtn = document.querySelector('.submit-add');
        if (!submitBtn) {
          throw new Error('未找到「立即投稿」按钮');
        }
        submitBtn.click();
        logMsg('  已点击「立即投稿」');
        ok++;
        const nm = getTaskTitle(task);
        markSubmitted(nm);              // 本地记账（接口落库延迟，不等它）
        fillSubmittedIds(nm);           // 异步补 bvid/aid
      } catch (err) {
        fail++;
        logMsg('  [FAIL] ' + err.message);
      }

      if (!abortFlag) {
        // 等待投稿完成，让 B 站处理并从列表中移除
        await delay(CONFIG.DELAY_BETWEEN_TASKS + 1000);
      }
    }

    processing = false;
    disableButtons(false);
    hideProgress();
    const msg = '批量投稿完成: 成功 ' + ok + ', 失败 ' + fail;
    logMsg('==== ' + msg + ' ====');
    notify(msg, fail > 0 ? 'warning' : 'success');
  }

  // ===========================
  // 【新增：配置预设】存取多套设置
  // ===========================
  const PRESET_KEY = 'bb_presets_v1';
  function loadPresetMap() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function savePresetMap(map) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(map)); return true; } catch (e) { logMsg('预设写入失败: ' + e.message); return false; }
  }
  /** 把面板当前所有设置收成一个对象（只读 UI，不动业务状态） */
  function collectSettings(root) {
    const q = (sel) => root.querySelector(sel);
    const opts = {};
    root.querySelectorAll('.bb-run-opt').forEach((c) => { opts[c.dataset.k] = c.checked; });
    return {
      coverMode: (root.querySelector('input[name="bb-mode"]:checked') || {}).value || 'match',
      privacy: (root.querySelector('input[name="bb-privacy"]:checked') || {}).value || '仅自己可见',
      runOpts: opts,
      title: q('#bb-title') ? q('#bb-title').checked : true,
      ts: q('#bb-ts') ? q('#bb-ts').checked : false,
      spaceHide: q('#bb-spacehide') ? q('#bb-spacehide').checked : true,
      frame: q('#bb-frame') ? q('#bb-frame').value : '0',
      intro: q('#bb-intro') ? q('#bb-intro').value : '',
      fan: q('#bb-fan') ? q('#bb-fan').value : '',
      season: q('#bb-season') ? q('#bb-season').value : '',
      titleTpl: q('#bb-title-tpl') ? q('#bb-title-tpl').value : '',
      waitUpload: q('#bb-wait-upload') ? q('#bb-wait-upload').checked : true,
      rateBackoff: q('#bb-ratebackoff') ? q('#bb-ratebackoff').checked : false,
      autoMode: autoUp.mode,
      autoBatch: autoUp.batch,
      autoSettings: JSON.parse(JSON.stringify(autoSettings)),
    };
  }
  /** 把一套预设写回面板（触发 change 让脚本内部状态跟着同步） */
  function applySettings(root, s) {
    if (!s) return;
    const setRadio = (name, val) => {
      const r = root.querySelector('input[name="' + name + '"][value="' + val + '"]');
      if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    setRadio('bb-mode', s.coverMode);
    setRadio('bb-privacy', s.privacy);
    if (s.runOpts) root.querySelectorAll('.bb-run-opt').forEach((c) => {
      if (s.runOpts[c.dataset.k] !== undefined && c.checked !== !!s.runOpts[c.dataset.k]) {
        c.checked = !!s.runOpts[c.dataset.k];
        c.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const setChk = (sel, val) => { const e = root.querySelector(sel); if (e) e.checked = !!val; };
    setChk('#bb-title', s.title !== false);
    setChk('#bb-ts', s.ts);
    setChk('#bb-spacehide', s.spaceHide !== false);
    setChk('#bb-wait-upload', s.waitUpload !== false);
    setChk('#bb-ratebackoff', s.rateBackoff);
    const setTxt = (sel, val) => { const e = root.querySelector(sel); if (e) e.value = val || ''; };
    setTxt('#bb-intro', s.intro);
    setTxt('#bb-fan', s.fan);
    setTxt('#bb-season', s.season);
    setTxt('#bb-title-tpl', s.titleTpl);
    setTxt('#bb-frame', s.frame);
    if (s.autoMode) autoUp.mode = s.autoMode;
    if (s.autoBatch) autoUp.batch = s.autoBatch;
    if (s.autoSettings) {
      Object.assign(autoSettings, s.autoSettings);
      if (s.autoSettings.runOpts) Object.assign(autoSettings.runOpts, s.autoSettings.runOpts);
      syncAutoSettingsUI();
    }
    renderPresetBar();
    renderAuto();
    logMsg('已套用预设：' + (s.name || '未命名'));
  }

  /** 把 autoSettings 写回自动上传区的控件（套用预设后用） */
  function syncAutoSettingsUI() {
    const root = document.getElementById('bili-batch-panel');
    if (!root) return;
    root.querySelectorAll('.bb-auto-opt').forEach((c) => {
      if (c.dataset && c.dataset.k !== undefined && autoSettings.runOpts[c.dataset.k] !== undefined) {
        c.checked = !!autoSettings.runOpts[c.dataset.k];
      }
    });
    root.querySelectorAll('input[name="bb-auto-cover"]').forEach((r) => { r.checked = r.value === autoSettings.coverMode; });
    root.querySelectorAll('input[name="bb-auto-privacy"]').forEach((r) => { r.checked = r.value === autoSettings.privacy; });
    const s = root.querySelector('#bb-auto-season');
    if (s) s.value = autoSettings.season || '';
    const rb = root.querySelector('#bb-auto-ratebackoff');
    if (rb) rb.checked = !!autoSettings.rateBackoff;
    const rfb = root.querySelector('#bb-auto-refreshbatch');
    if (rfb) rfb.checked = autoSettings.batchRefresh !== false;
    const ac = root.querySelector('#bb-auto-autoconfirm');
    if (ac) ac.checked = autoSettings.autoConfirm !== false;
    const kn = root.querySelector('#bb-auto-keepname');
    if (kn) kn.checked = autoSettings.keepName !== false;
    const tp = root.querySelector('#bb-auto-title-tpl');
    if (tp) tp.value = autoSettings.titleTpl || '';
  }

  // ===========================
  // 【PS 模式】读 U 盘 → 一次注入 ≤100 个 → 批量设元数据 → 提交
  // ===========================
  const autoUp = {
    mode: 'full',          // full=全自动；confirm=提交前停下
    batch: CONFIG.AUTO_BATCH,
    handle: null,          // FileSystemDirectoryHandle
    pathName: '',
    videos: [],            // {name, file, coverId}
    status: 'idle',        // idle | nodisk | ready | running | done
    running: false,
    abort: false,
    pollTimer: null,
    uploaded: 0,
    skipUploaded: true,        // 【新增】排除已上传
    publishedTitles: null,     // 账号「内容管理-稿件」的标题集合
    skipped: 0,
    seasonNames: [],           // 账号合集名缓存（面板重建后用它补填下拉）
    seasonList: [],            // [{id, name}]，来自接口
    scanning: false,
    pendingCount: 0,
    covers: [],                // 同目录扫到的封面图
    coversLoaded: false,       // 是否已把封面放进封面池（放进去了全局「匹配明细」才看得见）
    withCover: 0,
    matchExact: 0,
    matchNoTs: 0,
    coverDone: new Set(),      // 已成功设过封面的视频名（重试时排除）
    submittedLocal: new Map(), // 本地记账：标题(小写) -> {bvid, aid, at}，接口落库延迟靠它兜底
    reloads: 0,                // 因「每批刷新」自动 reload 的次数（超过 3 次停止，防死循环）
    onlyNames: null,           // 多管线：本页只处理这些视频名（Set），null = 全部
  };

  const SUBMIT_KEY = 'bb_autoup_submitted';
  const RESUME_KEY = 'bb_autoup_resume';

  /**
   * 【修复】B站 提交完一批后，上传组件不再接受新文件，必须刷新重开页面。
   * 所以每批结束时把「还有没跑完」记到 sessionStorage，刷新后自动接着跑。
   * 续跑不靠游标（pending 会因 submittedLocal 变短导致错位），
   * 而是靠 submittedLocal 排除已提交的，重新扫描后自然只剩没传的。
   */
  function saveResume(reloads) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        at: Date.now(),
        settings: autoSettings,
        batch: autoUp.batch,
        mode: autoUp.mode,
        uploaded: autoUp.uploaded,
        reloads: reloads || 0,
        onlyNames: autoUp.onlyNames ? [...autoUp.onlyNames] : null,   // 多管线：刷新后不能丢分片
      }));
    } catch (e) { /* 忽略 */ }
  }
  function loadResume() {
    try {
      const s = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
      if (!s || !s.at) return null;
      if (Date.now() - s.at > 30 * 60 * 1000) { clearResume(); return null; }   // 30 分钟没续上就作废
      return s;
    } catch (e) { return null; }
  }
  function clearResume() {
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) { /* 忽略 */ }
  }

  // ==================================================
  // 【2.3】ArchiveSyncManager —— 稿件索引与同步（本地存档系统）
  //   标题是唯一匹配依据（PS5 录像按录制时间命名，同名即同一个视频）。
  //   只做规范化后的精确匹配：去路径/去扩展名/小写/全角转半角。
  //   不做模糊、不做相似度、不做内容哈希。
  // ==================================================
  const ARCHIVE_KEY = 'bb_archive_index_v1';
  const SYNC_KEY = 'bb_archive_sync_v1';

  function loadArchiveIndex() {
    try {
      const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || 'null');
      if (raw && raw.byTitle) return raw;
    } catch (e) { /* 忽略 */ }
    return { byTitle: {}, byBvid: {}, count: 0 };
  }
  function saveArchiveIndex(idx) {
    try {
      // 【修复】多标签页并发写会互相覆盖：先读最新，合并后再写
      const cur = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '{"byTitle":{},"byBvid":{}}') || {};
      const merged = {
        byTitle: Object.assign({}, cur.byTitle || {}, idx.byTitle || {}),
        byBvid: Object.assign({}, cur.byBvid || {}, idx.byBvid || {}),
        count: 0,
      };
      merged.count = Object.keys(merged.byTitle).length;
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(merged));
      // 内存同步成合并结果，避免后续用旧数据覆盖回去
      idx.byTitle = merged.byTitle;
      idx.byBvid = merged.byBvid;
      idx.count = merged.count;
    } catch (e) { logMsg('[同步] 本地索引写入失败: ' + (e && e.message)); }
  }
  function loadSyncState() {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function saveSyncState(st) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(st)); } catch (e) { /* 忽略 */ }
  }

  const ArchiveSyncManager = {
    index: null,
    state: null,
    running: false,

    init() {
      this.index = loadArchiveIndex();
      this.state = loadSyncState();
      return this;
    },

    /** 标题规范化（跟封面匹配同一套规则） */
    keyOf(title) { return normName(title); },

    /** 查本地索引：命中返回 {bvid, aid, title, state, syncedAt} */
    find(title) {
      const k = this.keyOf(title);
      return (this.index && this.index.byTitle[k]) || null;
    },

    /** 投稿成功后立即入索引 —— 下一批立刻生效，不等接口落库 */
    addLocal(title, meta) {
      const k = this.keyOf(title);
      const prev = this.index.byTitle[k] || {};
      this.index.byTitle[k] = Object.assign({
        title: String(title),
        bvid: '',
        aid: 0,
        state: 'local',
        source: 'local',
        at: prev.at || Date.now(),
        syncedAt: Date.now(),
      }, meta || {});
      const bvid = this.index.byTitle[k].bvid;
      if (bvid) this.index.byBvid[bvid] = k;
      this.index.count = Object.keys(this.index.byTitle).length;
      saveArchiveIndex(this.index);
    },

    /**
     * 全量同步：分页读到尽，不能只读第一页。
     * 接口失败就把错误如实记下来，绝不把旧数据当最新数据。
     */
    async syncAll(opts) {
      if (this.running) return this.state;
      this.running = true;
      const st = {
        startedAt: Date.now(),
        finishedAt: 0,
        ok: false,
        error: '',
        readCount: 0,
        pages: 0,
        pageCount: 0,
        partial: false,
        forced: !!(opts && opts.force),
      };
      let page = 1;
      let read = 0;
      try {
        for (;;) {
          const u = 'https://member.bilibili.com/x/web/archives?type=pub&pn=' + page + '&ps=50';
          const r = await fetch(u, { credentials: 'include' });
          const j = await r.json();
          if (!j || j.code !== 0) {
            st.error = '接口返回 code=' + (j && j.code) + ' ' + (j && j.message || '');
            break;
          }
          const arr = (j.data && j.data.arc_audits) || [];
          const total = (j.data && j.data.page && j.data.page.count) || 0;
          st.pageCount = total;
          if (!arr.length) break;
          arr.forEach((x) => {
            const a = x && x.Archive;
            if (!a || !a.title) return;
            const k = this.keyOf(a.title);
            const prev = this.index.byTitle[k] || {};
            this.index.byTitle[k] = {
              title: String(a.title),
              bvid: a.bvid || prev.bvid || '',
              aid: a.aid || prev.aid || 0,
              state: typeof a.state === 'number' ? a.state : null,
              stateDesc: a.state_desc || '',
              onlySelf: a.is_only_self,
              source: prev.source || 'archive',
              at: prev.at || Date.now(),
              syncedAt: Date.now(),
            };
            if (a.bvid) this.index.byBvid[a.bvid] = k;
          });
          read += arr.length;
          st.pages = page;
          if (total && read >= total) break;
          if (arr.length < 50) break;
          page++;
          if (page > 300) { st.partial = true; break; }   // 兜底，防接口异常导致死循环
          await delay(180);
        }
        if (!st.error && !st.partial) st.ok = true;
      } catch (e) {
        st.error = (e && e.message) || '同步失败';
      }
      st.readCount = read;
      st.finishedAt = Date.now();
      this.index.count = Object.keys(this.index.byTitle).length;
      saveArchiveIndex(this.index);
      saveSyncState(st);
      this.state = st;
      this.running = false;
      return st;
    },

    /** 同步状态摘要（写进日志/统计） */
    summary() {
      const s = this.state || {};
      const when = s.finishedAt ? new Date(s.finishedAt).toLocaleString('zh-CN') : '从未同步';
      return {
        syncAt: when,
        ok: !!s.ok,
        error: s.error || '',
        readCount: s.readCount || 0,
        pages: s.pages || 0,
        total: s.pageCount || 0,
        partial: !!s.partial,
        localCount: (this.index && this.index.count) || 0,
      };
    },
  }.init();

  // ==================================================
  // 【2.3】多管线并发 —— 多标签页同时上传
  //   用户明确：上传并发 = 浏览器多开几个上传页面，各自跑。
  //   架构：主页面当调度器，把待传任务**预先切成 N 片**存 localStorage，
  //   再开 N 个标签页（URL 带 ?bb_worker=i），每页认领自己那片。
  //   用「预先分片」而不是动态抢任务：localStorage 没有事务，动态抢会竞态。
  //   每个标签页有自己的表单，元数据设置也真并行（不是只有文件上传并行）。
  // ==================================================
  const PIPE_KEY = 'bb_autoup_pipeline';
  const SHARD_KEY = 'bb_autoup_shard_';
  const SHARD_DONE_KEY = 'bb_autoup_shard_done_';

  function splitArray(arr, n) {
    const out = [];
    const size = Math.ceil(arr.length / Math.max(1, n));
    for (let i = 0; i < n; i++) out.push(arr.slice(i * size, (i + 1) * size));
    return out.filter((x) => x.length);
  }
  function loadPipeline() {
    try { return JSON.parse(localStorage.getItem(PIPE_KEY) || 'null'); } catch (e) { return null; }
  }
  function savePipeline(p) {
    try { localStorage.setItem(PIPE_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
  }
  function workerIndex() {
    const m = location.search.match(/[?&]bb_worker=(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  }
  function loadShard(i) {
    try { return JSON.parse(localStorage.getItem(SHARD_KEY + i) || 'null') || []; } catch (e) { return []; }
  }
  function loadShardDone(i) {
    try { return JSON.parse(localStorage.getItem(SHARD_DONE_KEY + i) || 'null'); } catch (e) { return null; }
  }
  function saveShardDone(i, info) {
    try { localStorage.setItem(SHARD_DONE_KEY + i, JSON.stringify(info)); } catch (e) { /* 忽略 */ }
  }
  const SHARD_OWNER_KEY = 'bb_autoup_shard_owner_';
  /**
   * 【修复】自动认领一片任务 —— 不靠 URL 参数。
   * 用户手动开的标签页地址里没有 ?bb_worker=，脚本认不出是 worker，
   * 结果那个页面跑全部任务、跟主页面抢同一批。改成谁打开谁认领一片。
   * 认领规则：没被认领过、也没跑完的，第一个来的领走（localStorage 记 owner）。
   */
  function claimShard() {
    const pipe = loadPipeline();
    if (!pipe) return -1;
    for (let i = 0; i < pipe.n; i++) {
      let owner = null;
      try { owner = localStorage.getItem(SHARD_OWNER_KEY + i); } catch (e) { /* 忽略 */ }
      if (owner) continue;                       // 已被认领
      if (loadShardDone(i)) continue;            // 已跑完
      try { localStorage.setItem(SHARD_OWNER_KEY + i, 'page:' + Date.now()); } catch (e) { /* 忽略 */ }
      autoUp.claimedShard = i;   // 记住本页认领的片，等目录授权后自动开跑
      logMsg('[多管线] 本页自动认领管线 ' + (i + 1));
      return i;
    }
    return -1;
  }

  /**
   * 【修复】认领分片（带重试）。
   * 新标签页可能比主页面先加载完，那时 pipeline 还没写进 localStorage，
   * 只试一次会永远认领不到 → 第二页面干等着不动。这里等主页面写出来再认领。
   */
  async function claimShardWithRetry(maxTry) {
    const n = maxTry || 12;
    for (let i = 0; i < n; i++) {
      if (workerIndex() >= 0) return workerIndex();     // URL 显式指定优先
      const w = claimShard();
      if (w >= 0) return w;
      if (loadPipeline()) return -1;                    // pipeline 有了但没片可领 → 别人都领走了
      if (i === 0) logMsg('[多管线] 等待主页面分配任务…');
      await delay(3000);                                // 还没分配，等一会儿再试
    }
    return -1;
  }

  /** 主页面：切片 + 开窗口 + 自己跑第 0 片 */
  async function startMultiPipeline(n, onlyCount) {
    if (autoUp.running) { notify('队列正在跑', 'warning'); return; }
    // 【修复】面板刚加载时 IndexedDB 恢复句柄是异步的，直接判断 handle 会静默返回（点了没反应）
    if (!autoUp.handle) {
      logMsg('[多管线] 等待 U 盘目录恢复…');
      for (let i = 0; i < 20 && !autoUp.handle && !autoUp.pendingHandle; i++) await delay(500);
    }
    if (!autoUp.handle && autoUp.pendingHandle) {
      notify('U 盘目录需要授权：点一下面板任意处即可恢复，然后重新启动', 'warning');
      logMsg('[多管线] 目录待授权（点面板任意处恢复），本次不启动');
      return;
    }
    if (!autoUp.handle) { notify('请先选择 U 盘目录', 'warning'); return; }
    n = Math.max(1, Math.min(4, n | 0 || 1));
    await scanDrive();
    let pending = autoUp.videos.filter((v) => {
      if (autoUp.coverDone.has(v.base)) return false;
      if (autoUp.skipUploaded && v.uploaded) return false;
      return true;
    });
    if (onlyCount) pending = pending.slice(0, onlyCount);   // 测试用：只跑前 N 个
    if (!pending.length) { notify('没有待上传的视频', 'warning'); return; }
    const shards = splitArray(pending.map((v) => v.base), n);
    shards.forEach((names, i) => {
      try { localStorage.setItem(SHARD_KEY + i, JSON.stringify(names)); } catch (e) { /* 忽略 */ }
      try { localStorage.removeItem(SHARD_DONE_KEY + i); } catch (e) { /* 忽略 */ }
    });
    // 清掉上一次残留的多余分片（比如上次 4 路、这次 2 路）
    for (let i = shards.length; i < 4; i++) {
      try { localStorage.removeItem(SHARD_KEY + i); } catch (e) { /* 忽略 */ }
      try { localStorage.removeItem(SHARD_DONE_KEY + i); } catch (e) { /* 忽略 */ }
    }
    const pipe = {
      n: shards.length,
      startedAt: Date.now(),
      master: location.href,
      total: pending.length,
      ids: shards.map((s, i) => i),
    };
    savePipeline(pipe);
    // 清掉旧认领记录，主页面认领第 0 片
    for (let i = 0; i < 20; i++) { try { localStorage.removeItem(SHARD_OWNER_KEY + i); } catch (e) { /* 忽略 */ } }
    try { localStorage.setItem(SHARD_OWNER_KEY + '0', 'master:' + Date.now()); } catch (e) { /* 忽略 */ }
    logMsg('==== 多管线启动：并发 ' + shards.length + ' 路，共 ' + pending.length + ' 个任务 ====');
    shards.forEach((s, i) => logMsg('  管线 ' + (i + 1) + '：' + s.length + ' 个（' + s.slice(0, 3).join('、') + (s.length > 3 ? '…' : '') + '）'));
    notify('多管线启动：' + shards.length + ' 路并发', 'info');
    // 开 N-1 个新标签页（当前页跑第 0 片）
    const base = location.href.replace(/[?&]bb_worker=\d+/, '');
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    for (let i = 1; i < shards.length; i++) {
      try {
        const w = window.open(base + sep + 'bb_worker=' + i, '_blank');
        if (!w) logMsg('[多管线] 管线 ' + (i + 1) + ' 窗口被浏览器拦截，请手动打开标签页（地址加 ?bb_worker=' + i + '）');
      } catch (e) {
        logMsg('[多管线] 管线 ' + (i + 1) + ' 开窗失败: ' + (e && e.message));
      }
      await delay(700);
    }
    renderPipeStatus();
    // 主页面自己跑第 0 片
    await runShard(0);
  }

  /** 跑自己那片（主页面和 worker 页面都走这里） */
  async function runShard(i) {
    const names = loadShard(i);
    if (!names.length) {
      logMsg('[多管线] 管线 ' + (i + 1) + ' 没有分到任务');
      saveShardDone(i, { ok: true, done: 0, total: 0, at: Date.now() });
      renderPipeStatus();
      return;
    }
    if (autoUp.dryRun) {   // 试跑：只看分片结果，不真上传
      logMsg('[多管线][试跑] 管线 ' + (i + 1) + ' 分到 ' + names.length + ' 个：'
        + names.slice(0, 6).join('、') + (names.length > 6 ? '…' : ''));
      saveShardDone(i, { ok: true, done: 0, total: names.length, at: Date.now(), dryRun: true });
      renderPipeStatus();
      return;
    }
    logMsg('==== [管线 ' + (i + 1) + '] 开跑：' + names.length + ' 个任务 ====');
    autoUp.onlyNames = new Set(names);
    try {
      await startAutoQueue();
    } finally {
      autoUp.onlyNames = null;
      saveShardDone(i, {
        ok: true,
        done: autoUp.uploaded,
        total: names.length,
        at: Date.now(),
        aborted: !!autoUp.abort,
      });
      logMsg('==== [管线 ' + (i + 1) + '] 结束 ====');
      renderPipeStatus();
    }
  }

  /** 管线状态汇总（主页面显示） */
  function renderPipeStatus() {
    const box = document.getElementById('bb-pipe-status');
    const pipe = loadPipeline();
    if (!box) return;
    if (!pipe) { box.innerHTML = ''; return; }
    const rows = [];
    // 认领了分片但目录还没授权 —— 明确告诉用户点这里（新标签页必经这一步）
    if (autoUp.pendingHandle && autoUp.claimedShard != null) {
      rows.push('<div style="color:#c00;font-weight:600;">⚠ 本页认领了管线 ' + (autoUp.claimedShard + 1)
        + '，点一下面板任意处授权 U 盘，之后自动开跑</div>');
    }
    for (let i = 0; i < pipe.n; i++) {
      const names = loadShard(i);
      const d = loadShardDone(i);
      const isMe = (i === 0 && workerIndex() < 0);
      const state = d ? (d.aborted ? '已中止' : '完成') + ' ' + d.done + '/' + d.total
        : (isMe && autoUp.running ? '进行中 ' + autoUp.uploaded + '/' + names.length : '等待中 ' + names.length + ' 个');
      rows.push('<div>管线 ' + (i + 1) + '：' + state + '</div>');
    }
    box.innerHTML = rows.join('');
  }

  /** 全停：让所有管线的队列停下（靠共享标记） */
  function stopAllPipelines() {
    try { localStorage.setItem('bb_autoup_stop_all', String(Date.now())); } catch (e) { /* 忽略 */ }
    autoUp.abort = true;
    abortFlag = true;
    logMsg('[多管线] 已请求全部停止');
    renderPipeStatus();
  }
  function checkStopAll() {
    const v = localStorage.getItem('bb_autoup_stop_all');
    return v && (Date.now() - Number(v) < 5000);   // 5 秒内的停止请求
  }
  /** 提交成功后本地立即记账（含 ID）—— 接口落库有延迟，不等它 */
  function markSubmitted(title, id) {
    const t = String(title || '').trim().toLowerCase();
    if (!t) return;
    // 【修复】写前先合并其他页面的记录，避免用旧内存覆盖掉别人的提交记录
    try {
      const cur = JSON.parse(localStorage.getItem(SUBMIT_KEY) || '[]');
      if (Array.isArray(cur)) cur.forEach((kv) => {
        if (kv && kv[0] && !autoUp.submittedLocal.has(kv[0])) autoUp.submittedLocal.set(kv[0], kv[1]);
      });
    } catch (e) { /* 忽略 */ }
    const rec = autoUp.submittedLocal.get(t);
    if (!rec) {
      autoUp.submittedLocal.set(t, {
        bvid: (id && id.bvid) || '',
        aid: (id && id.aid) || '',
        at: Date.now(),
      });
      saveSubmitted();
      ArchiveSyncManager.addLocal(title, id || {});   // 【2.3】投稿成功立刻进本地索引
    } else if (id && id.bvid && !rec.bvid) {
      rec.bvid = id.bvid;
      rec.aid = id.aid || rec.aid;
      saveSubmitted();
    }
  }
  function saveSubmitted() {
    try {
      // 【修复】多标签页并发写会互相覆盖：先读最新，合并后再写
      const cur = JSON.parse(localStorage.getItem(SUBMIT_KEY) || '[]') || [];
      const map = new Map(Array.isArray(cur) ? cur : []);
      autoUp.submittedLocal.forEach((v, k) => map.set(k, v));
      autoUp.submittedLocal = map;
      localStorage.setItem(SUBMIT_KEY, JSON.stringify([...map.entries()]));
    } catch (e) { /* 忽略 */ }
  }
  function loadSubmitted() {
    try {
      const arr = JSON.parse(localStorage.getItem(SUBMIT_KEY) || '[]');
      autoUp.submittedLocal = new Map(Array.isArray(arr) ? arr : []);
    } catch (e) { autoUp.submittedLocal = new Map(); }
    return autoUp.submittedLocal.size;
  }
  /** 提交后查接口补上 bvid/aid（接口可能还没落库，查不到就只留标题） */
  async function fillSubmittedIds(title) {
    try {
      const r = await fetch('https://member.bilibili.com/x/web/archives?type=pub&pn=1&ps=50', { credentials: 'include' });
      const j = await r.json();
      const arr = (j && j.data && j.data.arc_audits) || [];
      const want = String(title || '').trim();
      const hit = arr.find((x) => {
        const a = x.Archive || {};
        return String(a.title || '').trim() === want;
      });
      if (hit && hit.Archive) markSubmitted(want, { bvid: hit.Archive.bvid, aid: hit.Archive.aid });
    } catch (e) { /* 忽略 */ }
  }

  const COVER_DONE_KEY = 'bb_autoup_cover_done';
  /** 封面设置成功后记录（跨会话保留，重试一轮时排除） */
  function markCoverDone(name) {
    if (!name) return;
    if (autoUp.coverDone.has(name)) return;
    autoUp.coverDone.add(name);
    try { localStorage.setItem(COVER_DONE_KEY, JSON.stringify([...autoUp.coverDone])); } catch (e) { /* 忽略 */ }
  }
  function loadCoverDone() {
    try {
      const arr = JSON.parse(localStorage.getItem(COVER_DONE_KEY) || '[]');
      if (Array.isArray(arr)) autoUp.coverDone = new Set(arr);
    } catch (e) { autoUp.coverDone = new Set(); }
    return autoUp.coverDone.size;
  }
  function clearCoverDone() {
    autoUp.coverDone = new Set();
    try { localStorage.removeItem(COVER_DONE_KEY); } catch (e) { /* 忽略 */ }
    renderAuto();
    logMsg('已清空「已设过封面」记录');
  }

  /** 【2.3】排除统计（规格要求的 7 项） */
  function renderArchiveReport() {
    const box = document.getElementById('bb-archive-report');
    if (!box) return;
    const rep = autoUp.archiveReport;
    const s = ArchiveSyncManager.summary();
    const row = (k, v) => '<div><b>' + k + '：</b>' + v + '</div>';
    const syncTxt = s.syncAt + (s.ok ? ' ✓' : (s.error ? ' ✗ ' + escapeHtml(s.error) : '（未完成）'));
    if (!rep) {
      box.innerHTML = row('本地稿件索引', s.localCount + ' 条') + row('同步时间 / 状态', syncTxt);
      return;
    }
    box.innerHTML =
      row('本地视频总数', rep.localCount + ' 个') +
      row('B站稿件读取数量', rep.archiveRead + ' 条' + (s.total ? '（接口合计 ' + s.total + '）' : '')) +
      row('已上传排除数量', rep.excluded + ' 个') +
      row('未上传数量', rep.pending + ' 个') +
      row('标题重复数量', rep.dupLocal + ' 组（本地同名）') +
      row('本地记录命中数量', rep.localHit + ' 个（仅本地记账，接口未落库）') +
      row('同步时间 / 状态', syncTxt);
  }

  /** 【2.3】排除明细：每个本地文件命中了哪条稿件（标题 + bvid） */
  function renderArchiveRows() {
    const box = document.getElementById('bb-archive-rows');
    if (!box) return;
    const rep = autoUp.archiveReport;
    if (!rep || !rep.rows || !rep.rows.length) { box.innerHTML = '<div>没有明细</div>'; return; }
    box.innerHTML = rep.rows.slice(0, 200).map((r) => {
      const tag = r.by === 'none' ? '<span style="color:#c00">未匹配</span>'
        : (r.by === 'local' ? '<span style="color:#06c">本地</span>' : '<span style="color:#080">已上传</span>');
      return '<div>' + tag + ' ' + escapeHtml(r.file) +
        (r.bvid ? ' → ' + escapeHtml(r.bvid) : (r.title ? ' → ' + escapeHtml(r.title) : '')) + '</div>';
    }).join('') + (rep.rows.length > 200 ? '<div>…另有 ' + (rep.rows.length - 200) + ' 条</div>' : '');
  }
  const AUTO_VIDEO_RE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
  const AUTO_COVER_RE = /\.(jpe?g|png|webp)$/i;

  /**
   * 【新增】自动上传的独立设置：与面板上半部分那套全局设置分开，勾选 = 启用。
   * 跑队列时临时套用到全局变量上，跑完立刻还原，不影响你手动批量处理别的稿件。
   */
  const autoSettings = {
    coverMode: 'match',
    privacy: '仅自己可见',
    season: '',
    titleTpl: '',              // 自定义标题模板（{name}=原名）
    keepName: true,            // 保留原名上传（默认）
    rateBackoff: true,          // 限流自动暂停（默认开，避免「请求频率过高」把封面卡掉）
    batchRefresh: true,         // 每批提交后自动刷新页面再继续（B站 提交后上传组件不再收新文件）
    autoConfirm: true,          // 提前授权：自动上传提交时不再弹 confirm 框（打通全自动）
    runOpts: {
      title: true, declaration: true, tags: true, spaceHide: true, cover: true, season: true, nodyn: true,
      watermark: false, danmaku: false, comment: false, featured: false,
      schedule: false, erchuang: false, dolby: false, hires: false,
    },
  };

  function idbOpen() {
    return new Promise((res) => {
      let req;
      try { req = indexedDB.open(CONFIG.AUTO_IDB, 1); } catch (e) { return res(null); }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('dir')) req.result.createObjectStore('dir');
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    });
  }
  async function idbGetDir() {
    const db = await idbOpen();
    if (!db) return null;
    return new Promise((res) => {
      try {
        const r = db.transaction('dir', 'readonly').objectStore('dir').get('root');
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }
  async function idbSetDir(handle) {
    const db = await idbOpen();
    if (!db) return;
    try {
      const tx = db.transaction('dir', 'readwrite');
      if (handle) tx.objectStore('dir').put(handle, 'root');
      else tx.objectStore('dir').delete('root');
      tx.onerror = () => {};
    } catch (e) { /* 忽略 */ }
  }

  /** 递归收集媒体：视频 + 同目录封面图（PS5 把 .webm/.mp4 和同名 .jpg 放一起） */
  async function collectMedia(handle, prefix) {
    const videos = [];
    const covers = [];
    const stack = [[handle, prefix || '']];
    while (stack.length) {
      const [h, p] = stack.pop();
      let it;
      try { it = h.values(); } catch (e) { continue; }
      for await (const entry of it) {
        const np = p ? p + '/' + entry.name : entry.name;
        if (entry.kind === 'directory') {
          stack.push([entry, np]);
        } else if (AUTO_VIDEO_RE.test(entry.name)) {
          videos.push({ name: entry.name, path: np, handle: entry });
        } else if (AUTO_COVER_RE.test(entry.name)) {
          covers.push({ name: entry.name, path: np, handle: entry });
        }
      }
    }
    return { videos: videos, covers: covers };
  }

  /** B站视频上传入口：优先 accept 含 video 的 file input */
  function findVideoInput() {
    const list = [...document.querySelectorAll('input[type=file]')];
    return list.find((i) => /video/i.test(i.accept || ''))
      || list.find((i) => !/image/i.test(i.accept || ''))
      || null;
  }

  /** 一次性把一批视频注入上传队列，让 B站 自己并行上传 */
  async function injectVideos(files) {
    const input = findVideoInput();
    if (!input) throw new Error('找不到视频上传入口（页面结构可能变了）');
    const dt = new DataTransfer();
    for (const f of files) {
      // DataTransferItemList.add 只收 File；FileSystemFileHandle 要先 getFile()
      if (f instanceof File) dt.items.add(f);
      else logMsg('跳过非 File 对象: ' + (f && f.name || typeof f));
    }
    if (!dt.items.length) throw new Error('没有可注入的文件');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return dt.items.length;
  }

  /** 自动上传独立设置的摘要（只写日志，便于追溯本批用了哪套） */
  function autoSettingsSummary() {
    const modeTxt = ({ match: '按文件名配封面', single: '同一张封面', system: '系统推荐封面' })[autoSettings.coverMode] || autoSettings.coverMode;
    const nameMap = {
      title: '标题', declaration: '声明', tags: '标签', spaceHide: '空间隐藏', cover: '封面', season: '合集',
      watermark: '水印', danmaku: '弹幕', comment: '评论', featured: '精选', schedule: '定时',
      erchuang: '二创', dolby: '杜比', hires: 'Hi-Res',
    };
    const opts = Object.keys(autoSettings.runOpts)
      .filter((k) => autoSettings.runOpts[k])
      .map((k) => nameMap[k] || k);
    return modeTxt + ' · ' + autoSettings.privacy
      + (opts.length ? ' · ' + opts.join('/') : '')
      + (autoSettings.season ? ' · 合集 ' + autoSettings.season : '');
  }

  /**
   * 【新增】从账号接口拉合集列表：`/x2/creative/web/seasons`。
   * 这条路不依赖页面有没有投稿任务（用户：不是什么时候都有任务）。
   * 返回 [{id, name}]
   */
  async function fetchSeasonListFromApi(maxPages) {
    const out = [];
    const seen = new Set();
    const pages = maxPages || 3;
    for (let p = 1; p <= pages; p++) {
      try {
        const r = await fetch('https://member.bilibili.com/x2/creative/web/seasons?pn=' + p + '&ps=50&order=desc&sort=mtime&filter=1', { credentials: 'include' });
        const j = await r.json();
        const d = j && j.data;
        const arr = d && Array.isArray(d.seasons) ? d.seasons : [];
        if (!arr.length) break;
        let added = 0;
        arr.forEach((s) => {
          const sec = s && s.season;
          const name = sec && sec.title ? String(sec.title).trim() : '';
          if (name && !seen.has(name)) { seen.add(name); out.push({ id: sec.id, name: name }); added++; }
        });
        const total = d.total || 0;
        if (!total || out.length >= total || !added) break;
      } catch (e) {
        logMsg('[合集] 接口读取失败: ' + (e && e.message));
        break;
      }
    }
    return out;
  }

  /**
   * 抓账号的合集列表：优先走接口（任何时候都能读），读不到再从页面 DOM 兜底。
   */
  async function fetchSeasonList() {
    try {
      const list = await fetchSeasonListFromApi();
      if (list.length) {
        autoUp.seasonList = list;
        autoUp.seasonNames = list.map((x) => x.name);
        return autoUp.seasonNames;
      }
    } catch (e) { /* 落到 DOM 兜底 */ }

    // 兜底：页面表单里点开一次「加入合集」下拉读 .season-item-title
    const box = [...document.querySelectorAll('.video-season')].find((e) => e.offsetParent !== null)
      || document.querySelector('.video-season');
    if (!box) return [];
    const enter = box.querySelector('.season-enter');
    if (!enter) return [];
    const wasOpen = /season-enter-active/.test(enter.className);
    if (!wasOpen) enter.click();
    try { await waitFor(() => box.querySelector('.season-list .season-item-title'), 3500, 120); } catch (e) { /* 下面统一判 */ }
    const list = box.querySelector('.season-list.season-dropdown');
    const names = list
      ? [...list.querySelectorAll('.season-item')].map((it) => {
        const t = it.querySelector('.season-item-title');
        return (t ? t.textContent : it.textContent).trim();
      }).filter(Boolean)
      : [];
    if (!wasOpen) enter.click();
    if (names.length) autoUp.seasonNames = names;
    return names;
  }

  /** 把合集名写进两个下拉（详细设置 + 自动上传），保留当前选中值 */
  function applySeasonOptions(names) {
    ['bb-season', 'bb-auto-season'].forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">不设</option>' +
        names.map((n) => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
      if (names.indexOf(cur) >= 0) sel.value = cur;
    });
  }

  /**
   * 抓合集列表并重试：页面刚打开时任务/表单还没渲染，B站 就没「加入合集」可抓，
   * 单次尝试很容易空手而归，所以这里轮询重试。
   */
  async function ensureSeasonList(maxTry) {
    if (autoUp.seasonNames.length) { applySeasonOptions(autoUp.seasonNames); return autoUp.seasonNames; }
    const tries = maxTry || 10;
    for (let i = 0; i < tries; i++) {
      let names = [];
      try { names = await fetchSeasonList(); } catch (e) { names = []; }
      if (names.length) {
        applySeasonOptions(names);
        if (i > 0) logMsg('[合集] 第 ' + (i + 1) + ' 次尝试读到 ' + names.length + ' 个合集');
        return names;
      }
      await delay(1200);
    }
    logMsg('[合集] 没读到合集 —— 账号里可能还没有合集，或登录态失效；点「刷新」可重试');
    return [];
  }

  /** 拉「内容管理-稿件」里已发布的标题（分页），用于排除已上传的视频 */
  async function fetchPublishedTitles(maxPages) {
    const out = [];
    const seen = new Set();
    const pages = maxPages || 20;
    for (let p = 1; p <= pages; p++) {
      try {
        // 注意：必须用 pn= 分页；page= 会被 B站 忽略、每次都回第 1 页
        const r = await fetch('https://member.bilibili.com/x/web/archives?type=pub&pn=' + p + '&ps=50', { credentials: 'include' });
        const j = await r.json();
        const d = j && j.data;
        if (!d) break;
        const arr = d.arc_audits || d.archives || [];
        if (!arr.length) break;
        let added = 0;
        arr.forEach((it) => {
          const a = it.Archive || it;
          const t = a && a.title ? String(a.title).trim() : '';
          if (t && !seen.has(t)) { seen.add(t); out.push(t); added++; }
        });
        const total = (d.page && d.page.count) || 0;
        if (!total || out.length >= total || !added) break;
      } catch (e) {
        logMsg('[已上传] 拉稿件列表失败: ' + (e && e.message));
        break;
      }
    }
    return out;
  }

  function renderAuto() {
    const box = document.getElementById('bb-auto');
    if (!box) return;
    const st = document.getElementById('bb-auto-status');
    const pathEl = document.getElementById('bb-auto-path');
    const btn = document.getElementById('bb-auto-start');
    const stopBtn = document.getElementById('bb-auto-stop');
    if (pathEl) {
      // 记忆上次目录：句柄可能待授权，但名字要一直显示，让人知道没丢
      let lastName = autoUp.pathName;
      if (!lastName) { try { lastName = localStorage.getItem('bb_last_dir') || ''; } catch (e) { lastName = ''; } }
      if (lastName && autoUp.handle) {
        pathEl.textContent = lastName;
        pathEl.style.color = '';
        pathEl.style.cursor = '';
      } else if (lastName) {
        // 待授权：橙色 + 可点，明确告诉用户「点这里」而不是让他重新选
        pathEl.textContent = lastName + '（点这里授权）';
        pathEl.style.color = '#fa8c16';
        pathEl.style.cursor = 'pointer';
      } else {
        pathEl.textContent = '未设置';
        pathEl.style.color = '';
        pathEl.style.cursor = '';
      }
      pathEl.title = autoUp.handle ? '已授权，可直接扫描' : '上次选的目录会被记住，下次打开只需点一下这里授权';
    }
    if (st) {
      const skip = autoUp.skipped
        ? '（排除 ' + autoUp.skipped + '：精确' + autoUp.matchExact + '/去时间戳' + autoUp.matchNoTs + '）'
        : '';
      const map = {
        idle: '待启动',
        nodisk: 'U 盘未接入',
        ready: '已接入 · ' + autoUp.videos.length + ' 视频/' + autoUp.covers.length + ' 封面' + skip,
        running: '进行中 · 已传 ' + autoUp.uploaded + ' / ' + (autoUp.pendingCount || autoUp.videos.length),
        stopped: '已中止 · 已传 ' + autoUp.uploaded + ' / ' + (autoUp.pendingCount || autoUp.videos.length),
        done: '完成 · ' + autoUp.uploaded + ' / ' + (autoUp.pendingCount || autoUp.videos.length) + skip,
      };
      st.textContent = map[autoUp.status] || autoUp.status;
    }
    if (btn) { btn.disabled = autoUp.running || autoUp.status === 'nodisk'; btn.textContent = autoUp.running ? '队列执行中…' : '启动队列'; }
    if (stopBtn) stopBtn.disabled = !autoUp.running;
    box.querySelectorAll('input[name="bb-automode"]').forEach((r) => { r.checked = r.value === autoUp.mode; });
    const batchEl = document.getElementById('bb-auto-batch');
    if (batchEl) batchEl.value = String(autoUp.batch);
    // 面板被重建后下拉会退回初始态，用缓存补填（只在空的时候补，不覆盖你选的值）
    const selEl = document.getElementById('bb-auto-season');
    const gEl = document.getElementById('bb-season');
    if (autoUp.seasonNames.length && ((selEl && selEl.options.length <= 1) || (gEl && gEl.options.length <= 1))) {
      applySeasonOptions(autoUp.seasonNames);
    }
  }

  /** 选 U 盘目录（浏览器只能弹框选，不能敲盘符路径） */
  async function pickDriveDir() {
    try {
      const show = window.showDirectoryPicker;
      if (!show) { notify('当前浏览器不支持目录选择，请用最新 Chrome/Edge', 'error'); return; }
      const handle = await show({ id: 'bb-ps5', mode: 'read' });
      autoUp.handle = handle;
      autoUp.pathName = handle.name;
      try { localStorage.setItem('bb_last_dir', handle.name); } catch (e) { /* 忽略 */ }
      autoUp.publishedTitles = null;   // 换目录后重新拉稿件标题，避免用旧比对结果
      await idbSetDir(handle);
      await scanDrive();
      logMsg('U 盘目录已选定: ' + handle.name);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      logMsg('选择目录失败: ' + (e && e.message));
    }
    renderAuto();
  }

  async function scanDrive() {
    if (!autoUp.handle || autoUp.scanning) return;
    autoUp.scanning = true;
    try {
      const media = await collectMedia(autoUp.handle);
      autoUp.videos = media.videos;
      autoUp.covers = media.covers;
      // 同名封面配对：同目录里去掉扩展名后精确同名的那张
      const coverMap = new Map();
      media.covers.forEach((c) => {
        const key = c.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
        if (!coverMap.has(key)) coverMap.set(key, c);
      });
      let withCover = 0;
      autoUp.videos.forEach((v) => {
        v.base = v.name.replace(/\.[^.]+$/, '').trim();     // 统一用去扩展名做 key（跟 markCoverDone 一致）
        const key = v.base.toLowerCase();
        const hit = coverMap.get(key);
        v.coverHandle = hit ? hit.handle : null;
        v.coverName = hit ? hit.name : null;
        if (hit) withCover++;
      });
      autoUp.withCover = withCover;

      // 封面进封面池：全局「匹配明细」才看得到配对（File 是轻量引用，不读内容）
      if (media.covers.length && !autoUp.coversLoaded) {
        const cf = [];
        for (const c of media.covers) {
          try { cf.push(await c.handle.getFile()); } catch (e) { /* 忽略 */ }
        }
        for (let i = 0; i < cf.length; i += 200) {
          await addCovers(cf.slice(i, i + 200));   // 内部去重 + 渲染匹配明细
        }
        autoUp.coversLoaded = true;
        logMsg('[封面] 已进封面池 ' + cf.length + ' 张，「匹配明细」可核对');
      }

      // 【2.3】用本地稿件索引做「标题规范化后精确匹配」（同名即同一个视频）
      let skipped = 0, exact = 0, noTsHit = 0;
      const rep = {
        localCount: autoUp.videos.length, archiveRead: 0, excluded: 0, pending: 0,
        dupLocal: 0, localHit: 0, rows: [], syncAt: '从未同步', syncOk: false, syncError: '',
      };
      if (autoUp.skipUploaded && autoUp.videos.length) {
        if (!autoUp.publishedTitles) {
          const titles = await fetchPublishedTitles(20);
          autoUp.publishedTitles = new Set(titles.map((t) => t.toLowerCase()));
          // 实时拉到的标题并入本地索引，索引才是唯一匹配源
          titles.forEach((t) => { if (!ArchiveSyncManager.find(t)) ArchiveSyncManager.addLocal(t, { source: 'archive' }); });
          logMsg('[已上传] 从稿件管理拉到 ' + autoUp.publishedTitles.size + ' 条标题（已并入本地索引）');
        }
        // 本地文件标题重复统计（同名多个文件）
        const nameCount = {};
        autoUp.videos.forEach((v) => {
          const k = ArchiveSyncManager.keyOf(v.base);
          nameCount[k] = (nameCount[k] || 0) + 1;
        });
        rep.dupLocal = Object.keys(nameCount).filter((k) => nameCount[k] > 1).length;

        autoUp.videos.forEach((v) => {
          const base = v.base;
          const rec = ArchiveSyncManager.find(base);                                  // ① 精确
          const localRec = autoUp.submittedLocal.get(base.toLowerCase());
          const noTs = base.replace(/[_-]?\d{8,14}$/, '').trim();                      // ② 去时间戳
          const recTs = noTs && noTs !== base ? ArchiveSyncManager.find(noTs) : null;
          let recTpl = null;
          const tpl = (autoSettings.titleTpl || '').trim();                            // ③ 自定义模板反推
          if (tpl && autoSettings.keepName === false) {
            recTpl = ArchiveSyncManager.find(buildTitle(tpl, base));
          }
          const hit = rec || localRec || recTs || recTpl;
          if (hit) {
            v.uploaded = true;
            v.matchLevel = (rec || localRec) ? 'exact' : (recTs ? 'noTs' : 'tpl');
            v.matchedTitle = (hit && hit.title) || base;
            v.matchedBvid = (hit && hit.bvid) || (localRec && localRec.bvid) || '';
            exact++; skipped++;
            if (localRec && !rec) rep.localHit++;
            if (recTs && !rec && !localRec) rep.noTsHit++;
            rep.rows.push({ file: base, title: v.matchedTitle, bvid: v.matchedBvid,
              by: rec ? 'archive' : (localRec ? 'local' : (recTs ? 'noTs' : 'tpl')) });
          } else {
            v.uploaded = false; v.matchLevel = 'none';
            v.matchedTitle = ''; v.matchedBvid = '';
            rep.rows.push({ file: base, title: '', bvid: '', by: 'none' });
          }
        });
        // 规格：保留时间戳的有效信息，不做去时间戳/模糊/哈希匹配
        rep.excluded = exact;
        rep.pending = autoUp.videos.length - exact;
        rep.archiveRead = ArchiveSyncManager.index.count;
        const s = ArchiveSyncManager.summary();
        rep.syncAt = s.syncAt;
        rep.syncOk = s.ok;
        rep.syncError = s.error;
        autoUp.archiveReport = rep;
        logMsg('[对比] 本地 ' + rep.localCount + ' 个 × 稿件索引 ' + rep.archiveRead + ' 条 → 排除 ' + rep.excluded
          + '（本地记录命中 ' + rep.localHit + '）/ 待上传 ' + rep.pending
          + (rep.dupLocal ? ' / 本地标题重复 ' + rep.dupLocal : ''));
        logMsg('[同步] 最近同步 ' + rep.syncAt + (rep.syncOk ? '' : (rep.syncError ? '（' + rep.syncError + '）' : '（未完成）')));
        if (withCover) logMsg('[封面] 同名配对 ' + withCover + ' / ' + autoUp.videos.length);
      }
      autoUp.skipped = skipped;
      autoUp.matchExact = exact;
      autoUp.matchNoTs = noTsHit;
      autoUp.status = autoUp.videos.length ? 'ready' : 'nodisk';
    } catch (e) {
      autoUp.videos = [];
      autoUp.skipped = 0;
      autoUp.coversLoaded = false;
      autoUp.status = 'nodisk';
    } finally {
      autoUp.scanning = false;
    }
    renderAuto();
    renderArchiveReport();
  }

  /** 启动队列：分批一次注入 batch 个，等传完设元数据再按模式提交 */
  async function startAutoQueue(isResume) {
    if (autoUp.running) return;
    if (!isResume) autoUp.reloads = 0;   // 手动启动时重置刷新计数
    // 目录授权优先：新标签页的 U 盘句柄需要一次用户手势，缺这一步会看起来像「没反应」
    if (!autoUp.handle && autoUp.pendingHandle) {
      notify('点一下面板授权 U 盘目录，然后会自动开跑', 'warning');
      logMsg('[多管线] 等待目录授权 —— 点一下面板任意处即可');
      return;
    }
    if (!autoUp.handle) { notify('请先选择 U 盘目录', 'warning'); return; }
    // 【2.3】开跑前确保稿件数据足够新（30 分钟内或从未同步 → 先同步）
    // 多管线 worker 页跳过：索引是主页面同步的，多个页面同时同步会互相抢接口
    if (workerIndex() < 0) {
      const st = ArchiveSyncManager.state || {};
      const age = st.finishedAt ? (Date.now() - st.finishedAt) : Infinity;
      if (!st.ok || age > 30 * 60 * 1000) {
        logMsg('[同步] 稿件索引过旧（' + (st.finishedAt ? Math.round(age / 60000) + ' 分钟前' : '从未') + '），先全量同步…');
        const r = await ArchiveSyncManager.syncAll({ force: false });
        if (r.ok) logMsg('[同步] 全量同步完成：' + r.readCount + ' 条 / ' + r.pages + ' 页');
        else logMsg('[同步] 同步失败：' + (r.error || '') + '（继续跑，但排除可能不全）');
      }
    }
    await scanDrive();
    const pending = autoUp.videos.filter((v) => {
      if (autoUp.onlyNames && !autoUp.onlyNames.has(v.base)) return false;   // 多管线：只跑分给本页的
      if (autoUp.coverDone.has(v.base)) return false;             // 已设过封面的不重跑
      if (autoUp.skipUploaded && v.uploaded) return false;       // 已发布的不跑
      return true;
    });
    autoUp.pendingCount = pending.length;
    const doneCovers = autoUp.videos.filter((v) => autoUp.coverDone.has(v.base)).length;
    if (!pending.length) {
      const why = doneCovers ? ('全部 ' + doneCovers + ' 个都已设过封面')
        : (autoUp.skipped ? ('全部 ' + autoUp.skipped + ' 个都已上传过') : 'U 盘里没扫到视频');
      notify(why + '，无需排队', 'warning');
      return;
    }
    logMsg('待排队 ' + pending.length + ' 个'
      + (autoUp.skipped ? '，排除已发布 ' + autoUp.skipped : '')
      + (doneCovers ? '，排除已设封面 ' + doneCovers : ''));
    autoUp.running = true;
    autoUp.abort = false;
    autoUp.status = 'running';
    autoUp.uploaded = 0;
    renderAuto();
    logMsg('PS 模式使用独立设置：' + autoSettingsSummary());
    // 临时把独立设置套到全局那套（processAllTasks 读的是全局），跑完立刻还原
    const backup = {
      coverMode: coverMode,
      privacyWant: privacyWant,
      runOpts: Object.assign({}, runOpts),
      season: (document.getElementById('bb-season') || {}).value || '',
      rateLimitBackoff: rateLimitBackoff,
    };
    coverMode = autoSettings.coverMode;
    privacyWant = autoSettings.privacy;
    Object.assign(runOpts, autoSettings.runOpts);
    rateLimitBackoff = !!autoSettings.rateBackoff;   // 限流自动暂停（独立设置）
    const globalSeason = document.getElementById('bb-season');
    if (globalSeason) globalSeason.value = autoSettings.season;
    const total = pending.length;
    const size = Math.max(1, autoUp.batch | 0 || 100);
    try {
      for (let i = 0; i < total && !autoUp.abort; i += size) {
        if (!isCurrentInstance()) { autoUp.abort = true; logMsg('[单实例] 旧实例退出'); break; }   // 被新实例接管
        if (checkStopAll()) { autoUp.abort = true; break; }   // 多管线「全停」
        const chunk = pending.slice(i, i + size);
        logMsg('准备 ' + chunk.length + ' 个视频（' + (i + 1) + '-' + (i + chunk.length) + ' / ' + total + '）');
        // 注意：collectVideos 存的是 FileSystemFileHandle，必须 getFile() 才是 File
        const files = [];
        for (const v of chunk) {
          try {
            if (v.handle && typeof v.handle.getFile === 'function') files.push(await v.handle.getFile());
            else if (v.file) files.push(v.file);
          } catch (e) {
            logMsg('读不出文件: ' + v.name + '（' + (e && e.message) + '）');
          }
        }
        if (!files.length) { logMsg('这一批一个文件都没读出来，跳过'); continue; }
        const n = await injectVideos(files);
        logMsg('已注入 ' + n + ' 个到上传队列');
        await delay(700);
        await dismissBatchDialog();   // 注入后 B站 会弹「批量上传提示」，先关掉，否则挡住所有操作
        // 同目录的同名封面也一起读进来，交给现有「按文件名匹配」
        const coverFiles = [];
        for (const v of chunk) {
          if (v.coverHandle && typeof v.coverHandle.getFile === 'function') {
            try { coverFiles.push(await v.coverHandle.getFile()); } catch (e) { /* 忽略 */ }
          }
        }
        if (coverFiles.length) {
          await addCovers(coverFiles);
          logMsg('本批带入 ' + coverFiles.length + ' 张同名封面');
        }
        await delay(800);
        // 等任务卡出现
        await waitFor(() => getTasks().length >= chunk.length, 30000, 500);
        // 配封面（按原文件名）并设元数据
        buildMatch();
        renderMatch();
        await processAllTasks();
        // 自己 check 封面是不是都设上了，缺的补到全有（这一批里的小轮）
        await fillCoversUntilDone(chunk);
        // 等这批上传完成
        await waitAllUploaded(Math.min(30, Math.ceil(chunk.length / 6) * 2));
        autoUp.uploaded += chunk.length;
        renderAuto();
        // 提交
        if (autoUp.mode === 'full') {
          await processBatchSubmit(autoSettings.autoConfirm !== false);   // 提前授权 → 跳过 confirm
          logMsg('本批已提交' + (autoSettings.autoConfirm !== false ? '（提前授权，未弹确认）' : ''));
          // 本地记账立刻生效：这批已提交的标成 uploaded，下一批不会重复
          autoUp.videos.forEach((v) => {
            if (autoUp.submittedLocal.has((v.base || '').toLowerCase())) v.uploaded = true;
          });
          renderAuto();
          // 还有下一批 → B站 提交后上传组件不再收新文件，必须刷新重开页面才能继续
          const hasMore = (i + size) < total;
          if (hasMore && autoSettings.batchRefresh !== false && !autoUp.abort) {
            saveResume((autoUp.reloads || 0) + 1);
            logMsg('==== 这批已提交（' + (i + chunk.length) + '/' + total + '），自动刷新页面继续下一批 ====');
            notify('本批已提交，自动刷新继续下一批', 'info');
            await delay(1500);
            location.reload();
            return;
          }
        } else {
          logMsg('已设好元数据，等你确认后手动提交（提交前确认模式）');
          break;
        }
      }
      if (autoUp.abort) {
        autoUp.status = 'stopped';
        clearResume();          // 用户主动停，不再续跑
        logMsg('==== 队列已中止（不是完成）：已传 ' + autoUp.uploaded + ' / ' + autoUp.pendingCount + ' ====');
        notify('队列已中止（不是完成）: 已传 ' + autoUp.uploaded + '/' + autoUp.pendingCount, 'warning');
      } else {
        autoUp.status = 'done';
        clearResume();          // 全部跑完，清掉断点
        logMsg('==== 队列完成：已传 ' + autoUp.uploaded + ' / ' + autoUp.pendingCount + ' ====');
        notify('队列完成: ' + autoUp.uploaded + '/' + autoUp.pendingCount, 'success');
      }
    } catch (e) {
      logMsg('队列出错: ' + (e && e.message));
      notify('队列中断: ' + (e && e.message), 'error');
      autoUp.status = 'stopped';
    } finally {
      // 还原全局设置，避免影响你手动批量处理别的稿件
      coverMode = backup.coverMode;
      privacyWant = backup.privacyWant;
      Object.assign(runOpts, backup.runOpts);
      rateLimitBackoff = backup.rateLimitBackoff;
      if (globalSeason) globalSeason.value = backup.season;
      autoUp.running = false;
      renderAuto();
    }
  }

  /**
   * 自己 check 这批封面是不是都设上了，缺的补，直到全有（用户要的「这一轮里那个小的一轮」）。
   * 判定靠 coverDone（封面设成功会记一条）—— B站 接口的 cover 永远非空（自动给推荐帧），区分不了。
   */
  async function fillCoversUntilDone(chunk, maxRound) {
    const rounds = maxRound || 8;
    for (let r = 1; r <= rounds; r++) {
      if (autoUp.abort || abortFlag) return;
      const missing = chunk.filter((v) => !autoUp.coverDone.has(v.base));
      if (!missing.length) {
        if (r > 1) logMsg('封面补齐：这批 ' + chunk.length + ' 个已全有封面');
        return;
      }
      logMsg('封面补齐（小轮 ' + r + '/' + rounds + '）：还缺 ' + missing.length + ' 个');
      let noCover = 0;
      for (const v of missing) {
        if (autoUp.abort || abortFlag) return;
        const tasks = getTasks();
        const rows = buildMatch();
        let idx = -1;
        rows.forEach((row, i) => { if (row.videoBase === v.base) idx = i; });
        if (idx < 0 || !tasks[idx]) {
          logMsg('  [封面补齐] 页面上找不到「' + v.base + '」的任务卡，跳过');
          noCover++;
          continue;
        }
        const c = coverById(rows[idx].coverId);
        if (!c) {
          logMsg('  [封面补齐]「' + v.base + '」没有可贴的封面（未匹配），跳过');
          noCover++;
          continue;
        }
        // 只重设封面，不重跑整套设置 —— 之前这里调 processSingleTask，8 轮空转极慢
        selectTask(tasks[idx]);
        await delay(250);
        logMsg('  [封面补齐] 补 ' + v.base + ' → ' + c.file.name);
        const okCover = await setCoverWithBackoff(c.file);
        if (okCover) markCoverDone(v.base);
        await backoffIfLimited();
        await delay(CONFIG.DELAY_BETWEEN_TASKS);
      }
      // 这一轮全是「没有可贴的封面」→ 再重试也没意义，直接停，别空转 8 轮
      if (noCover === missing.length) {
        logMsg('封面补齐：这 ' + missing.length + ' 个都没有可贴的封面（匹配不到），停止重试');
        return;
      }
    }
    const still = chunk.filter((v) => !autoUp.coverDone.has(v.base));
    if (still.length) {
      logMsg('封面补齐：跑了 ' + rounds + ' 轮仍有 ' + still.length + ' 个没封面：'
        + still.slice(0, 12).map((v) => v.base).join('、') + (still.length > 12 ? '…' : ''));
    }
  }

  /** 重试一轮：跳过已设过封面的和已发布的，只补没跑成的 */
  async function retryQueue() {
    if (autoUp.running) { notify('队列正在跑', 'warning'); return; }
    if (!autoUp.handle) { notify('请先选择 U 盘目录', 'warning'); return; }
    autoUp.publishedTitles = null;
    logMsg('重试一轮：已设过封面的 ' + autoUp.coverDone.size + ' 个会跳过');
    await startAutoQueue();
  }

  function stopAutoQueue() {
    autoUp.abort = true;
    abortFlag = true;
    logMsg('队列已请求停止');
    renderAuto();
  }

  /** 轮询近似检测 U 盘接入（浏览器没有 USB 插入事件，只能试读目录） */
  function startDriveWatch() {
    if (autoUp.pollTimer) return;
    autoUp.pollTimer = setInterval(async () => {
      if (!isCurrentInstance()) { try { clearInterval(autoUp.pollTimer); } catch (e) { /* 忽略 */ } return; }   // 旧实例自杀
      if (!autoUp.handle || autoUp.running) return;
      try {
        for await (const e of autoUp.handle.values()) { break; }   // 能读到就算接入
        if (autoUp.status === 'nodisk' || autoUp.status === 'idle') { await scanDrive(); logMsg('检测到 U 盘接入，' + autoUp.videos.length + ' 个视频'); }
      } catch (err) {
        if (autoUp.status !== 'nodisk') { autoUp.status = 'nodisk'; autoUp.videos = []; renderAuto(); logMsg('U 盘已拔出'); }
      }
    }, CONFIG.AUTO_POLL_MS);
  }

  /** 预设栏：下拉 + 存/删/导出/导入 */
  function renderPresetBar() {
    const sel = document.getElementById('bb-preset-sel');
    if (!sel) return;
    const map = loadPresetMap();
    const cur = sel.value;
    sel.innerHTML = '<option value="">（不使用预设）</option>' +
      Object.keys(map).map((k) => '<option value="' + escapeHtml(k) + '"' + (k === cur ? ' selected' : '') + '>' + escapeHtml(k) + '</option>').join('');
    if (cur) sel.value = cur;
    document.getElementById('bb-preset-del').disabled = !sel.value;
  }

  function initPresetBar(panel) {
    const sel = panel.querySelector('#bb-preset-sel');
    renderPresetBar();
    panel.querySelector('#bb-preset-save').onclick = () => {
      const name = (panel.querySelector('#bb-preset-name').value || '').trim();
      if (!name) { notify('先给预设起个名字', 'warning'); return; }
      const map = loadPresetMap();
      const s = collectSettings(panel);
      s.name = name;
      map[name] = s;
      if (savePresetMap(map)) { sel.value = name; renderPresetBar(); notify('预设已保存: ' + name, 'success'); }
    };
    sel.onchange = () => {
      const map = loadPresetMap();
      if (sel.value && map[sel.value]) applySettings(panel, map[sel.value]);
      renderPresetBar();
    };
    panel.querySelector('#bb-preset-del').onclick = () => {
      const name = sel.value;
      if (!name) return;
      const map = loadPresetMap();
      delete map[name];
      savePresetMap(map);
      sel.value = '';
      renderPresetBar();
      notify('已删除预设: ' + name, 'info');
    };
    panel.querySelector('#bb-preset-export').onclick = () => {
      const data = JSON.stringify(loadPresetMap(), null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      a.download = '投稿流水线-预设.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
  }

  function initAutoUpload(panel) {
    const doneN = loadCoverDone();
    if (doneN) logMsg('记住「已设过封面」' + doneN + ' 个（重试一轮时会跳过）');
    const subN = loadSubmitted();
    if (subN) logMsg('本地记账「已提交」' + subN + ' 条（接口没落库也认，下批不重复）');
    panel.querySelector('#bb-auto-pick').onclick = pickDriveDir;
    panel.querySelector('#bb-auto-start').onclick = () => { startAutoQueue(); };
    panel.querySelector('#bb-auto-stop').onclick = stopAutoQueue;
    panel.querySelector('#bb-auto-refresh').onclick = async () => {
      try {
        const names = await fetchSeasonList();
        if (names.length) { applySeasonOptions(names); logMsg('[合集] 已加载 ' + names.length + ' 个合集'); }
        else logMsg('[合集] 没读到合集 —— 账号里可能还没有合集，或登录态失效');
      } catch (e) { /* 忽略 */ }
      autoUp.publishedTitles = null;   // 强制重新拉稿件标题，重新做对比
      try { scanDrive(); } catch (e) { /* 忽略 */ }
    };
    panel.querySelectorAll('input[name="bb-automode"]').forEach((r) => {
      r.onchange = () => { if (r.checked) { autoUp.mode = r.value; renderAuto(); logMsg('自动上传模式 → ' + (r.value === 'full' ? '全自动' : '提交前确认')); } };
    });
    const batchEl = panel.querySelector('#bb-auto-batch');
    if (batchEl) batchEl.onchange = () => {
      const n = parseInt(batchEl.value, 10);
      autoUp.batch = (isFinite(n) && n > 0) ? n : CONFIG.AUTO_BATCH;
      batchEl.value = String(autoUp.batch);
    };
    // 恢复上次的目录句柄（浏览器重启后可能要再授权）
    idbGetDir().then(async (h) => {
      if (!h) { renderAuto(); return; }
      // 【修复】恢复句柄必须先校验权限：浏览器会把权限降级成 prompt/denied，
      // 不校验就直接用会导致扫描失败，看起来像「每次都要重选」。
      let ok = false;
      try {
        const p = await h.queryPermission({ mode: 'read' });
        if (p === 'granted') ok = true;
        else if (p === 'prompt') ok = (await h.requestPermission({ mode: 'read' }) === 'granted');
      } catch (e) { ok = false; }
      if (!ok) {
        autoUp.pendingHandle = h;
        autoUp.pathName = h.name;
        logMsg('记住的目录「' + h.name + '」需要重新授权 —— 点一下面板任意处即可恢复，不用重选目录');
        notify('点一下面板恢复 U 盘目录授权', 'warning');
        renderAuto();
        return;
      }
      autoUp.handle = h;
      autoUp.pathName = h.name;
      try { localStorage.setItem('bb_last_dir', h.name); } catch (e) { /* 忽略 */ }
      // 每次打开都强制刷新库存（不沿用上次的稿件标题比对结果）
      autoUp.publishedTitles = null;
      logMsg('已恢复上次目录「' + h.name + '」，自动扫描刷新库存…');
      await scanDrive();
      logMsg('库存已刷新：' + autoUp.videos.length + ' 个视频 / 排除 ' + autoUp.skipped + ' / 待传 ' + (autoUp.videos.length - autoUp.skipped));
      if (autoUp.status === 'nodisk') logMsg('记住的目录在：' + h.name + '（U 盘当前未接入）');
      renderAuto();
    });
    // 权限失效时：点一下面板（有用户手势）就能重新授权，不用重选目录
    panel.addEventListener('click', async () => {
      const ph = autoUp.pendingHandle;
      if (!ph || autoUp.handle) return;
      try {
        const r = await ph.requestPermission({ mode: 'read' });
        if (r === 'granted') {
          autoUp.pendingHandle = null;
          autoUp.handle = ph;
          autoUp.pathName = ph.name;
          logMsg('U 盘目录已恢复授权：' + ph.name);
          notify('U 盘目录已恢复', 'success');
          await scanDrive();
          renderAuto();
          // 【多管线】本页若已认领分片，授权后自动开跑
          if (autoUp.claimedShard != null && !autoUp.running) {
            logMsg('[多管线] 目录已授权，管线 ' + (autoUp.claimedShard + 1) + ' 自动开跑');
            await runShard(autoUp.claimedShard);
          }
        } else {
          // 【修复】之前这里什么都不做，用户点了没反应，就会觉得「记忆不生效」
          logMsg('[目录] 授权被拒绝（' + r + '）→ 请点「选择目录」重新选一次');
          notify('授权被拒绝，请点「选择目录」重选', 'warning');
          renderAuto();
        }
      } catch (e) {
        logMsg('[目录] 请求授权出错: ' + (e && e.message) + ' → 请点「选择目录」重选');
        notify('恢复目录失败，请点「选择目录」重选', 'warning');
        renderAuto();
      }
    });
    startDriveWatch();
    // 启动后抓一次账号的合集列表填进两个下拉
    setTimeout(async () => {
      try {
        const names = await fetchSeasonList();
        if (names.length) { applySeasonOptions(names); logMsg('[合集] 已加载 ' + names.length + ' 个合集'); }
      } catch (e) { /* 忽略 */ }
    }, 1500);

    // 断点续跑：上一批提交后刷新了页面，这里自动接上（靠 submittedLocal 排除已提交的）
    setTimeout(async () => {
      // 【2.3】多管线优先：认领一片自己跑（URL 显式 ?bb_worker=i，否则自动认领）
      const wiClaim = await claimShardWithRetry();
      if (wiClaim >= 0) {
        logMsg('[多管线] 本页是管线 ' + (wiClaim + 1) + '，自动开跑');
        for (let i = 0; i < 24 && !autoUp.handle; i++) await delay(500);   // 等目录句柄
        if (!autoUp.handle) {
          logMsg('[多管线] U 盘目录还没恢复，请点一次「选择目录」授权');
          notify('管线 ' + (wiClaim + 1) + ' 等待目录授权', 'warning');
          return;
        }
        await runShard(wiClaim);
        return;   // 认领了分片就不再走通用续跑
      }
      const rs = loadResume();
      if (!rs) return;
      if ((rs.reloads || 0) >= 3) {
        logMsg('[续跑] 已自动刷新 ' + rs.reloads + ' 次仍未完成，停止续跑（点「启动队列」手动继续）');
        clearResume();
        notify('自动刷新多次未完成，已停止，请手动检查', 'warning');
        return;
      }
      autoUp.reloads = rs.reloads || 0;
      autoUp.onlyNames = rs.onlyNames ? new Set(rs.onlyNames) : null;   // 多管线：刷新后恢复分片
      logMsg('[续跑] 检测到未完成的队列（上次已传 ' + (rs.uploaded || 0) + ' 个，已刷新 ' + (rs.reloads || 0) + ' 次），自动继续');
      if (rs.settings) Object.assign(autoSettings, rs.settings);
      autoUp.batch = rs.batch || autoUp.batch;
      autoUp.mode = rs.mode || autoUp.mode;
      // 刷新后页面是新任务，封面记录作废，避免「设过封面但没提交成功」的被漏掉
      clearCoverDone();
      const sel = document.getElementById('bb-auto-season');
      if (sel) sel.value = autoSettings.season || '';
      const kn = document.getElementById('bb-auto-keepname');
      if (kn) kn.checked = autoSettings.keepName !== false;
      const bt = document.getElementById('bb-auto-batch');
      if (bt) bt.value = String(autoUp.batch);
      for (let i = 0; i < 24 && !autoUp.handle; i++) await delay(500);   // 等目录句柄恢复
      if (!autoUp.handle) {
        logMsg('[续跑] U 盘目录还没恢复，停在这里（点「启动队列」可手动继续）');
        notify('续跑等待目录授权，点「启动队列」继续', 'warning');
        return;
      }
      await startAutoQueue(true);
    }, 2600);

  }

  // ===========================
  // UI
  // ===========================

  /**
   * 【Apple 风格配色层】只注入 CSS 覆盖视觉，绝不改动面板 DOM：
   * 原版每一个按钮的名称、位置、数量、id、data-action 与事件绑定都原样保留。
   * 之前那版把控件塞进折叠、改名、删掉 4 个控件，是错误做法，已废弃。
   */
  function applyAppleSkin() {
    if (document.getElementById('bb-skin')) return;
    const st = document.createElement('style');
    st.id = 'bb-skin';
    st.textContent = `
#bili-batch-panel{
  --bb-accent:#0071e3; --bb-ink:#1d1d1f; --bb-ink2:#6e6e73; --bb-danger:#ff3b30;
  --bb-line:rgba(60,60,67,.13); --bb-fill:rgba(120,120,128,.09);
  background:rgba(250,250,252,.88) !important;
  -webkit-backdrop-filter:saturate(180%) blur(24px); backdrop-filter:saturate(180%) blur(24px);
  border:.5px solid rgba(0,0,0,.10) !important; border-radius:16px !important;
  box-shadow:0 14px 44px rgba(0,0,0,.17) !important;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",Arial,sans-serif !important;
  color:var(--bb-ink) !important; font-size:13px !important; letter-spacing:0;
}
#bili-batch-panel *{box-sizing:border-box}
/* 顶栏：由蓝底白字改为透明玻璃 + 深色字 */
#bili-batch-panel #bili-batch-header{background:transparent !important;color:var(--bb-ink) !important;border-bottom:.5px solid var(--bb-line);padding:11px 14px !important}
#bili-batch-panel #bili-batch-header span{font-size:13px !important;font-weight:600;letter-spacing:-.01em}
#bili-batch-panel #bili-batch-header button{width:26px;height:26px;border-radius:50%;background:var(--bb-fill) !important;border:none !important;color:var(--bb-ink2) !important;font-size:13px !important;line-height:1;cursor:pointer;transition:background .12s}
#bili-batch-panel #bili-batch-header button:active{background:rgba(120,120,128,.22) !important}
#bili-batch-panel #bili-batch-body{padding:12px 14px 14px !important}
#bili-batch-panel #bili-batch-stats{font-size:11.5px !important;color:var(--bb-ink2) !important}
/* 封面来源卡片 */
#bili-batch-panel #bili-batch-stats + div{background:var(--bb-fill) !important;border:none !important;border-radius:11px !important;padding:10px !important}
#bili-batch-panel #bili-batch-stats + div > div:first-child{color:var(--bb-ink2) !important;font-size:10.5px !important;letter-spacing:.06em}
#bili-batch-panel #bili-batch-stats + div > div:nth-child(2){font-size:11.5px !important;gap:4px 9px !important}
#bili-batch-panel #bili-batch-stats + div label{white-space:nowrap}
#bili-batch-panel label{color:var(--bb-ink2) !important}
#bili-batch-panel label[style*="color:#ff4d4f"]{color:var(--bb-danger) !important}
#bili-batch-panel input[type="checkbox"],#bili-batch-panel input[type="radio"]{accent-color:var(--bb-accent)}
#bili-batch-panel select,#bili-batch-panel input[type="text"]{
  border:.5px solid var(--bb-line) !important;border-radius:7px !important;
  background:rgba(255,255,255,.85) !important;color:var(--bb-ink) !important;
  padding:3px 6px !important;font-family:inherit;outline:none;
}
#bili-batch-panel select:focus,#bili-batch-panel input[type="text"]:focus{border-color:var(--bb-accent) !important}
/* 功能按钮：全部保留，只统一成中性底；按功能分主次，不再用彩虹色 */
#bili-batch-panel button.bili-act,#bili-batch-panel button.bili-op{
  background:rgba(255,255,255,.82) !important;color:var(--bb-ink) !important;
  border:.5px solid var(--bb-line) !important;border-radius:9px !important;
  font-family:inherit !important;font-weight:500 !important;cursor:pointer;
  transition:transform .1s cubic-bezier(.2,.9,.25,1),background .12s;
}
#bili-batch-panel button.bili-act:active,#bili-batch-panel button.bili-op:active{transform:scale(.975);background:rgba(0,0,0,.05) !important}
/* 主操作 = 实心蓝，次主 = 浅蓝，危险 = 浅红 */
#bili-batch-panel button[data-action="setAll"]{background:var(--bb-accent) !important;color:#fff !important;border:none !important;font-weight:600 !important;border-radius:11px !important}
#bili-batch-panel button[data-action="allThenSubmit"]{background:rgba(0,113,227,.12) !important;color:var(--bb-accent) !important;border:none !important;font-weight:600 !important;border-radius:11px !important}
#bili-batch-panel button[data-action="batchSubmit"]{background:rgba(255,59,48,.10) !important;color:var(--bb-danger) !important;border:none !important}
#bili-batch-panel button[data-action="clearCover"],#bili-batch-panel button[data-action="abort"]{background:none !important;color:var(--bb-danger) !important;border:none !important}
/* 折叠区 */
#bili-batch-panel details{border:none !important;border-top:.5px solid var(--bb-line) !important;border-radius:0 !important;padding:2px 0 !important;font-size:11.5px !important}
#bili-batch-panel summary{cursor:pointer;list-style:none;color:var(--bb-ink2) !important;font-weight:500 !important;outline:none;padding:7px 0 !important}
#bili-batch-panel summary::-webkit-details-marker{display:none}
#bili-batch-panel summary::before{content:'›';display:inline-block;margin-right:6px;transition:transform .18s;font-size:14px}
#bili-batch-panel details[open] summary::before{transform:rotate(90deg)}
#bili-batch-panel details > div{color:var(--bb-ink2) !important}
#bili-batch-panel details span,#bili-batch-panel details b{color:inherit}
#bili-batch-panel div[style*="border-top:2px dashed #ff4d4f"]{border-top:.5px solid var(--bb-line) !important;color:var(--bb-ink2) !important;margin:6px 0 2px !important;padding-top:8px !important}
/* 摘要 / 匹配表 / 进度 / 日志 */
#bili-batch-panel #bb-summary{background:var(--bb-fill) !important;border:none !important;border-radius:9px !important;color:var(--bb-ink2) !important;padding:8px 10px !important}
#bili-batch-panel #bili-batch-match{border-top:none !important;max-height:158px !important}
#bili-batch-panel #bili-batch-match > div{border-bottom:.5px solid var(--bb-line) !important}
#bili-batch-panel #bili-batch-progress > div:nth-child(2){background:rgba(120,120,128,.18) !important;border-radius:99px !important;height:4px !important;overflow:hidden}
#bili-batch-panel #bili-batch-progress-bar{background:var(--bb-accent) !important;transition:width .25s ease}
#bili-batch-panel #bili-batch-progress-text{color:var(--bb-ink2) !important}
#bili-batch-panel #bili-batch-log{background:rgba(0,0,0,.035) !important;border-radius:9px !important;color:var(--bb-ink2) !important;font-family:ui-monospace,SFMono-Regular,Menlo,monospace !important}
/* 匹配明细默认收起：常见路径优先，要看再点开（Simplicity / Wayfinding） */
#bili-batch-panel #bb-match-fold{border-top:.5px solid var(--bb-line);padding:0 !important;font-size:11.5px !important;border-radius:0 !important}
#bili-batch-panel #bb-match-fold > summary{cursor:pointer;list-style:none;color:var(--bb-ink2);font-size:11.5px;padding:7px 0;outline:none;transition:opacity .12s}
#bili-batch-panel #bb-match-fold > summary:active{opacity:.55}
#bili-batch-panel #bb-match-fold > summary::-webkit-details-marker{display:none}
#bili-batch-panel #bb-match-fold > summary::before{content:'›';display:inline-block;margin-right:6px;font-size:14px;transition:transform .18s}
#bili-batch-panel #bb-match-fold[open] > summary::before{transform:rotate(90deg)}
#bili-batch-panel #bb-match-fold .bb-fold-body{padding-bottom:8px}
#bili-batch-panel #bb-match-fold #bb-summary{margin-bottom:6px}
#bili-batch-panel .bb-hidden{display:none !important}
/* 【新增】预设栏 / 自动上传区 */
#bili-batch-panel .bb-nbtn{border:.5px solid var(--bb-line);border-radius:7px;background:rgba(255,255,255,.82) !important;color:var(--bb-ink) !important;font-family:inherit;font-size:11px;padding:3px 8px;cursor:pointer;transition:transform .1s,background .12s}
#bili-batch-panel .bb-nbtn:active{transform:scale(.97);background:rgba(0,0,0,.05) !important}
#bili-batch-panel .bb-nbtn.bb-nbtn-ok{background:rgba(52,199,89,.14) !important;color:#0a7d33 !important;border-color:transparent}
#bili-batch-panel .bb-nbtn.bb-nbtn-danger{background:rgba(255,59,48,.10) !important;color:var(--bb-danger) !important;border-color:transparent}
#bili-batch-panel .bb-nbtn.bb-nbtn-primary{background:var(--bb-accent) !important;color:#fff !important;border:none !important;font-weight:600}
#bili-batch-panel .bb-nbtn:disabled{opacity:.5;cursor:default}
#bili-batch-panel #bb-auto{background:var(--bb-fill) !important;border:none !important;border-radius:11px !important}
#bili-batch-panel #bb-auto input[type="number"]{width:48px;font-size:11px;padding:2px 4px;border:.5px solid var(--bb-line) !important;border-radius:6px !important;background:#fff !important}
#bili-batch-panel #bb-auto label{color:var(--bb-ink2) !important}
#bili-batch-panel #bb-preset-bar select,#bili-batch-panel #bb-preset-bar input{border:.5px solid var(--bb-line) !important;border-radius:6px !important;background:rgba(255,255,255,.85) !important;color:var(--bb-ink) !important;font-family:inherit}
#bili-batch-panel #bb-auto-set{border-top:.5px solid var(--bb-line) !important}
#bili-batch-panel #bb-auto-set > div{color:var(--bb-ink2) !important}
#bili-batch-panel #bb-auto-set label{margin-right:2px}
@media (prefers-reduced-transparency:reduce){#bili-batch-panel{background:#fff !important;backdrop-filter:none;-webkit-backdrop-filter:none}}
@media (prefers-reduced-motion:reduce){#bili-batch-panel button,#bili-batch-panel summary::before{transition:none !important}#bili-batch-panel button:active{transform:none !important}}
`;
    document.head.appendChild(st);
  }

  /* BB_TIDY_START */
  /**
   * 【布局整理】不删控件、不改按钮文案，只做两件事：
   * 1) 状态摘要 + 逐条匹配明细装进默认收起的折叠区，需要核对时点开即可
   * 2) 隐藏纯说明性文字；按钮、勾选框、输入框、选项标签一个都不动
   */
  function tidyLayout(panel) {
    const match = panel.querySelector('#bili-batch-match');
    const summary = panel.querySelector('#bb-summary');
    if (match && !panel.querySelector('#bb-match-fold')) {
      const det = document.createElement('details');
      det.id = 'bb-match-fold';
      const sum = document.createElement('summary');
      sum.textContent = '匹配明细';
      det.appendChild(sum);
      const body = document.createElement('div');
      body.className = 'bb-fold-body';
      det.appendChild(body);
      match.parentNode.insertBefore(det, match);
      if (summary) body.appendChild(summary);
      body.appendChild(match);
    }
    // 纯说明文字（不是控件）一律收掉；用 class 隐藏而非删除，随时可恢复
    [
      '#bili-batch-stats + div > div:first-child',             // 「封面来源」小标题
      '#bb-summary',                                           // 与勾选项重复的 6 行状态说明
      'details > div[style*="flex-wrap:wrap"] > span',          // 「勾 = 执行…」
      'div[style*="border-top:2px dashed #ff4d4f"]'             // 「— 以下为独立功能 —」
    ].forEach((sel) => panel.querySelectorAll(sel).forEach((el) => el.classList.add('bb-hidden')));
    // 分区 / 标签说明行按文本隐藏（不依赖子元素顺序，插入新行也不会错位）
    panel.querySelectorAll('details > div[style*="border-top:1px dashed #eee"] > div').forEach((el) => {
      if (/^(分区|标签)/.test((el.textContent || '').trim())) el.classList.add('bb-hidden');
    });

    // 折叠标题里的冗余措辞
    panel.querySelectorAll('summary').forEach((s) => {
      if (s.textContent.indexOf('一键包含的项目') >= 0) s.textContent = '详细设置';
    });
    // 「系统推荐帧：用第 [1] 张」→「推荐帧 [1]」；select 本身保留
    const frame = panel.querySelector('#bb-frame');
    if (frame && frame.parentNode) {
      [...frame.parentNode.childNodes].forEach((n) => {
        if (n.nodeType === 3) n.nodeValue = n.nodeValue.replace('系统推荐帧：用第', '推荐帧 ').replace('张', '');
      });
    }
    // 解释性括注（只改文本节点，不碰 radio / checkbox / 按钮）
    const drop = ['（页面真实只有这两项）', '（最多2分钟）', '（点开）'];
    const w = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (w.nextNode()) texts.push(w.currentNode);
    texts.forEach((n) => {
      let v = n.nodeValue;
      drop.forEach((d) => { v = v.split(d).join(''); });
      if (v !== n.nodeValue) n.nodeValue = v;
    });
  }
  /* BB_TIDY_END */

  function createPanel() {
    const existing = document.getElementById('bili-batch-panel');
    if (existing) existing.remove();
    applyAppleSkin();

    const panel = document.createElement('div');
    panel.id = 'bili-batch-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: CONFIG.PANEL_Z_INDEX,
      width: '360px', maxHeight: '550px', background: CONFIG.BG_COLOR,
      borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif',
      fontSize: '13px', color: '#333', overflow: 'hidden',
    });
    panel.innerHTML = `
      <div id="bili-batch-header" style="padding:10px 14px; background:${CONFIG.ACCENT_COLOR}; color:#fff; cursor:move; display:flex; align-items:center; justify-content:space-between; user-select:none;">
        <span style="font-size:14px; font-weight:600;">哔哩哔哩投稿流水线 3.5</span>
        <div style="display:flex; gap:6px;">
          <button id="bili-batch-min" style="background:none; border:none; color:#fff; cursor:pointer; font-size:16px;">–</button>
          <button id="bili-batch-close" style="background:none; border:none; color:#fff; cursor:pointer; font-size:16px;">✕</button>
        </div>
      </div>
      <div id="bili-batch-body" style="padding:12px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px;">
        

        <div id="bb-auto" style="border:1px solid #f0f0f0; border-radius:8px; padding:8px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span style="font-size:12px;font-weight:600;">自动上传</span>
            <span style="font-size:10px;background:#e8f4ff;color:#1890ff;border-radius:3px;padding:1px 5px;">PS 模式</span>
            <span style="flex:1"></span>
            <button class="bb-nbtn" id="bb-auto-pick">选择目录</button>
            <button class="bb-nbtn" id="bb-auto-refresh">刷新</button>
          </div>
          <div style="font-size:11px;color:#666;display:flex;gap:6px;align-items:center;">
            <span>路径</span>
            <span id="bb-auto-path" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">未设置</span>
          </div>
          <div id="bb-auto-status" style="font-size:11px;color:#666;margin:4px 0;">待启动</div>
          <div style="display:flex;gap:9px;align-items:center;margin-bottom:6px;font-size:11px;">
            <label><input type="radio" name="bb-automode" value="full" checked> 全自动</label>
            <label><input type="radio" name="bb-automode" value="confirm"> 提交前确认</label>
            <span style="flex:1"></span>
            <span>每批</span>
            <input type="number" id="bb-auto-batch" value="100" min="1" style="width:48px;font-size:11px;">
          </div>

          <div id="bb-auto-set" style="border-top:1px dashed #eee;margin:6px 0 0;padding-top:7px;">
            <div style="font-size:11px;font-weight:600;margin-bottom:5px;">自动上传设置</div>
            <div style="font-size:11px;color:#666;margin-bottom:4px;">
              封面
              <label><input type="radio" name="bb-auto-cover" value="match" checked> 按文件名</label>
              <label><input type="radio" name="bb-auto-cover" value="single"> 同一张</label>
              <label><input type="radio" name="bb-auto-cover" value="system"> 系统推荐</label>
            </div>
            <div style="font-size:11px;color:#666;margin-bottom:4px;">
              可见
              <label><input type="radio" name="bb-auto-privacy" value="仅自己可见" checked> 仅自己可见</label>
              <label><input type="radio" name="bb-auto-privacy" value="公开可见"> 公开</label>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:3px 10px;font-size:11px;margin-bottom:4px;">
              <label><input type="checkbox" class="bb-auto-opt" data-k="title" checked> 标题</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="declaration" checked> 声明</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="tags" checked> 标签</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="spaceHide" checked> 空间隐藏</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="cover" checked> 封面</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="season" checked> 合集</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="watermark"> 水印</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="danmaku"> 弹幕</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="comment"> 评论</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="featured"> 精选</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="schedule"> 定时</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="erchuang"> 二创</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="dolby"> 杜比</label>
              <label><input type="checkbox" class="bb-auto-opt" data-k="hires"> Hi-Res</label>
            </div>
            <div style="font-size:11px;color:#666;display:flex;align-items:center;gap:6px;">
              <label><input type="checkbox" id="bb-auto-keepname" checked> 保留原名</label>
              <input type="text" id="bb-auto-title-tpl" placeholder="自定义标题，{name}=原名" style="flex:1;font-size:11px;">
            </div>
            <div style="font-size:11px;color:#666;display:flex;align-items:center;gap:6px;">
              <span>合集</span>
              <select id="bb-auto-season" style="flex:1;font-size:11px;"><option value="">不设</option></select>
              <label style="margin-left:auto;"><input type="checkbox" id="bb-auto-skip" checked> 排除已上传</label>
            </div>
            <div style="font-size:11px;color:#666;display:flex;align-items:center;gap:10px;margin-top:3px;">
              <label><input type="checkbox" id="bb-auto-autoconfirm" checked> 提前授权（提交时不再弹确认框）</label>
            </div>
            <div style="font-size:11px;color:#666;display:flex;align-items:center;gap:10px;margin-top:3px;">
              <label><input type="checkbox" id="bb-auto-ratebackoff" checked> 限流自动暂停</label>
              <label><input type="checkbox" id="bb-auto-refreshbatch" checked> 每批刷新</label>
              <span style="flex:1"></span>
              <button class="bb-nbtn" id="bb-auto-retry" style="padding:2px 8px;font-size:10.5px;">重试一轮</button>
            </div>
            <div style="font-size:11px;color:#666;display:flex;align-items:center;gap:6px;margin-top:4px;">
              <span>并发管线</span>
              <select id="bb-pipe-count" style="font-size:11px;">
                <option value="1">1</option><option value="2">2</option>
                <option value="3">3</option><option value="4" selected>4</option>
              </select>
              <button class="bb-nbtn" id="bb-pipe-start" style="padding:2px 8px;font-size:10.5px;">启动多管线</button>
              <button class="bb-nbtn" id="bb-pipe-stop" style="padding:2px 8px;font-size:10.5px;">全停</button>
            </div>
            <div id="bb-pipe-status" style="margin-top:3px;font-size:11px;color:#667;"></div>
            <details style="margin-top:5px;font-size:11px;color:#666;">
              <summary style="cursor:pointer;">排除统计 ›</summary>
              <div id="bb-archive-report" style="margin-top:5px;line-height:1.8;">还没统计，扫描后会显示</div>
              <div style="margin-top:5px;display:flex;gap:6px;">
                <button class="bb-nbtn" id="bb-archive-sync" style="padding:2px 8px;font-size:10.5px;">强制同步稿件</button>
                <button class="bb-nbtn" id="bb-archive-detail" style="padding:2px 8px;font-size:10.5px;">看排除明细</button>
              </div>
              <div id="bb-archive-rows" style="margin-top:5px;display:none;max-height:180px;overflow:auto;line-height:1.7;"></div>
            </details>
          </div>

          <div style="display:flex;gap:6px;">
            <button class="bb-nbtn bb-nbtn-primary" id="bb-auto-start" style="flex:1;">启动队列</button>
            <button class="bb-nbtn bb-nbtn-danger" id="bb-auto-stop" style="width:62px;">停止</button>
          </div>
        </div>

<details style="font-size:10px;">
          <summary style="cursor:pointer; color:#999;">操作日志</summary>
          <div id="bili-batch-log" style="max-height:100px; overflow-y:auto; background:#f9f9f9; border-radius:4px; padding:6px; margin-top:4px; font-family:monospace; white-space:pre-wrap; word-break:break-all; color:#666;"></div>
        </details>

        <details style="font-size:10px; margin-top:4px;">
          <summary style="cursor:pointer; color:#999;">关于 / 检查更新</summary>
          <div style="margin-top:5px; line-height:1.8; color:#666;">
            <div>当前版本：<b id="bb-about-ver">-</b></div>
            <div>仓库：<a href="https://github.com/lhsheung/bili-upload-pipeline" target="_blank" style="color:#1890ff;">lhsheung/bili-upload-pipeline</a></div>
            <div id="bb-about-result" style="margin-top:4px;">尚未检查</div>
            <button class="bb-nbtn" id="bb-check-update" style="padding:2px 8px; font-size:10.5px; margin-top:5px;">检查更新</button>
          </div>
        </details>

<div id="bb-preset-bar" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
          <span style="font-size:11px;color:#666;">预设</span>
          <select id="bb-preset-sel" style="flex:1;min-width:86px;font-size:11px;padding:2px;"></select>
          <input type="text" id="bb-preset-name" placeholder="名称" style="width:62px;font-size:11px;padding:2px 4px;">
          <button class="bb-nbtn bb-nbtn-ok" id="bb-preset-save">存</button>
          <button class="bb-nbtn bb-nbtn-danger" id="bb-preset-del">删</button>
          <button class="bb-nbtn" id="bb-preset-export">导出</button>
        </div>
        <div id="bili-batch-stats" style="font-size:12px; color:#999; text-align:center;"></div>
        <!-- ↓↓↓ 【新增 4】封面来源 / 标题规则 / 匹配表 ↓↓↓ -->
        <div style="border:1px solid #f0f0f0; border-radius:8px; padding:8px;">
          <div style="font-size:11px; color:#666; margin-bottom:5px;">封面来源</div>
          <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:12px;">
            <label><input type="radio" name="bb-mode" value="match" checked> 按文件名匹配</label>
            <label><input type="radio" name="bb-mode" value="single"> 全部同一张</label>
            <label><input type="radio" name="bb-mode" value="system"> 系统推荐封面</label>
          </div>
          <div style="display:flex; gap:5px; margin-top:6px;">
            <button class="bili-act" data-action="pickCovers" style="flex:1; padding:5px; border:none; border-radius:5px; background:#4caf50; color:#fff; cursor:pointer; font-size:11px;">选图片(多选)</button>
            <button class="bili-act" data-action="pickFolder" style="flex:1; padding:5px; border:none; border-radius:5px; background:#607d8b; color:#fff; cursor:pointer; font-size:11px;">选文件夹</button>
          </div>
          <div style="margin-top:6px; font-size:11px; color:#666;">
            系统推荐帧：用第
            <select id="bb-frame" style="font-size:11px; padding:1px 2px;">
              <option value="0">1</option><option value="1">2</option><option value="2">3</option>
              <option value="3">4</option><option value="4">5</option><option value="5">6</option>
            </select> 张
          </div>
          <div style="margin-top:6px; font-size:11px; color:#666;">
            <label><input type="checkbox" id="bb-title" checked> 标题沿用原视频文件名</label>
            <label style="margin-left:6px;"><input type="checkbox" id="bb-ts"> 去末尾时间戳</label>
          </div>
        </div>
        <div id="bili-batch-match" style="max-height:150px; overflow-y:auto; border-top:1px dashed #eee;"></div>
        <!-- ↑↑↑ 【新增 4】↑↑↑ -->

        <div id="bili-batch-cover-preview" style="display:none; text-align:center;">
          <img id="bili-batch-cover-img" src="" style="max-width:100%; max-height:100px; border-radius:6px; border:1px solid #e8e8e8;">
          <button class="bili-op" data-action="clearCover" style="font-size:11px; color:#ff4d4f; background:none; border:none; cursor:pointer; margin-top:4px;">清除封面</button>
        </div>
        <div id="bili-batch-progress" style="display:none;">
          <div style="font-size:11px; color:#666; margin-bottom:3px;"><span id="bili-batch-progress-text"></span></div>
          <div style="background:#e8e8e8; border-radius:3px; height:5px;"><div id="bili-batch-progress-bar" style="background:${CONFIG.ACCENT_COLOR}; height:100%; width:0%;"></div></div>
          <button class="bili-op" data-action="abort" style="font-size:11px; color:#ff4d4f; background:none; border:1px solid #ff4d4f; border-radius:4px; padding:2px 10px; margin-top:4px; cursor:pointer;">中止</button>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px;">
          <div id="bb-summary" style="font-size:11px;line-height:1.65;background:#f6f8fc;border:1px solid #e8edf5;border-radius:6px;padding:6px 8px;color:#333;"></div>
          <button class="bili-act" data-action="setCover" style="padding:8px;border:none;border-radius:6px;background:#4caf50;color:#fff;cursor:pointer;font-size:12px;font-weight:500;">选择封面图片（本地上传）</button>
          <button class="bili-act" data-action="setAll" style="padding:10px;border:none;border-radius:6px;background:${CONFIG.ACCENT_COLOR};color:#fff;cursor:pointer;font-size:13px;font-weight:600;">一键全部设置</button>

          <details style="font-size:11px;border:1px solid #eee;border-radius:6px;padding:5px 7px;">
            <summary style="cursor:pointer;color:#666;font-weight:600;">一键包含的项目 / 详细设置（点开）</summary>
            <div style="display:flex;flex-wrap:wrap;gap:4px 10px;padding:6px 0;color:#555;">
              <span style="color:#999;width:100%;">勾 = 执行，不勾 = 跳过；每项都写明设成什么</span>
              <label><input type="checkbox" class="bb-run-opt" data-k="title" checked> 标题=视频文件名</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="declaration" checked> 创作声明=内容无需标注</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="privacy" checked> 可见范围（下方单选）</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="tags" checked> 标签=推荐+自定义</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="spaceHide" checked> 空间隐藏=开</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="cover" checked> 封面（上方来源）</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="watermark"> 添加水印</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="danmaku"> 关闭弹幕</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="comment"> 关闭评论</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="featured"> 精选评论</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="schedule"> 定时发布(开)</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="erchuang"> 允许二创</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="dolby"> 杜比音效</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="hires"> Hi-Res</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="season"> 加入合集</label>
              <label><input type="checkbox" class="bb-run-opt" data-k="nodyn"> 不生成动态</label>
              <label><input type="checkbox" id="bb-ratebackoff"> 限流时自动暂停（默认关）</label>
            </div>
            <div style="border-top:1px dashed #eee;padding-top:6px;line-height:1.95;color:#444;">
              <div><b>可见范围</b>（页面真实只有这两项）：
                <label><input type="radio" name="bb-privacy" value="仅自己可见" checked> 仅自己可见</label>
                <label><input type="radio" name="bb-privacy" value="公开可见"> 公开可见</label>
              </div>
              <div><label><input type="checkbox" id="bb-spacehide" checked> 空间隐藏</label></div>
              <div><b>分区</b> → <span style="color:#888;">B站已自动分好，保持原分区（该页下拉打不开，不支持修改）</span></div>
              <div><b>标签</b> → 自动添加 B站推荐标签</div>
              <div><b>简介</b> <input type="text" id="bb-intro" placeholder="留空=不改" style="width:130px;font-size:11px;">
                   <b>粉丝动态</b> <input type="text" id="bb-fan" placeholder="留空=不改" style="width:130px;font-size:11px;"></div>
              <div><b>标题</b> <input type="text" id="bb-title-tpl" placeholder="留空=用原文件名，{name}=原名" style="width:180px;font-size:11px;"></div>
              <div><b>合集</b> <select id="bb-season" style="width:150px;font-size:11px;"><option value="">不设</option></select></div>
              <div><label><input type="checkbox" id="bb-wait-upload"> 等全部上传完成才执行（最多2分钟）</label></div>
            </div>
          </details>

          <button class="bili-act" data-action="allThenSubmit" style="padding:10px;border:none;border-radius:6px;background:linear-gradient(90deg,#ff7a45,#ff4d4f);color:#fff;cursor:pointer;font-size:13px;font-weight:700;">一键全部设置 + 立即投稿</button>
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            <button class="bili-act" data-action="onlyTitle" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#607d8b;color:#fff;cursor:pointer;font-size:11px;">仅标题</button>
            <button class="bili-act" data-action="setDeclaration" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#2196f3;color:#fff;cursor:pointer;font-size:11px;">仅声明</button>
            <button class="bili-act" data-action="setPrivacy" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#ff9800;color:#fff;cursor:pointer;font-size:11px;">仅隐私</button>
            <button class="bili-act" data-action="setTags" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#e91e63;color:#fff;cursor:pointer;font-size:11px;">仅标签</button>
            <button class="bili-act" data-action="onlyCover" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#26c6da;color:#fff;cursor:pointer;font-size:11px;">仅封面</button>
            <button class="bili-act" data-action="spaceHide" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#7c4dff;color:#fff;cursor:pointer;font-size:11px;">隐藏开</button>
            <button class="bili-act" data-action="spaceHideOff" style="flex:1;min-width:58px;padding:6px;border:none;border-radius:5px;background:#9e9e9e;color:#fff;cursor:pointer;font-size:11px;">隐藏关</button>
          </div>
          <div style="border-top:2px dashed #ff4d4f;margin:8px 0 4px;padding-top:4px;font-size:10px;color:#ff4d4f;text-align:center;">— 以下为独立功能，与上方无关 —</div>
          <button class="bili-act" data-action="batchSubmit" style="padding:10px;border:none;border-radius:6px;background:#ff4d4f;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">批量立即投稿（独立）</button>
        </div>
        
      </div>`;
    document.body.appendChild(panel);
    tidyLayout(panel);
    makeDraggable(panel);
    requestAnimationFrame(() => bindEvents(panel));
    // 【独立初始化】关于/检查更新：不依赖 bindEvents（bindEvents 内部任一处异常都不该拖累这里）
    setTimeout(() => {
      try {
        const v = document.getElementById('bb-about-ver');
        if (v) v.textContent = MY_VERSION;
        const b = document.getElementById('bb-check-update');
        if (b && !b.dataset.bbBound) {
          b.dataset.bbBound = '1';
          b.addEventListener('click', () => { checkUpdate().catch(() => {}); });
        }
      } catch (e) { /* 忽略 */ }
    }, 300);
  }

  function bindEvents(panel) {
    panel.querySelector('#bili-batch-close').onclick = () => {
      panel.remove(); notify('面板已关闭，刷新页面可重新打开', 'info');
    };
    let minimized = false;
    const body = panel.querySelector('#bili-batch-body');
    panel.querySelector('#bili-batch-min').onclick = () => {
      minimized = !minimized;
      body.style.display = minimized ? 'none' : '';
      panel.querySelector('#bili-batch-min').textContent = minimized ? '+' : '–';
    };

    // ↓↓↓ 【新增 5】新控件的绑定 ↓↓↓
    body.querySelectorAll('input[name="bb-mode"]').forEach((r) => {
      r.onchange = () => {
        if (!r.checked) return;
        coverMode = r.value;
        buildMatch();
        renderMatch();
        logMsg('封面来源 → ' + r.value);
      };
    });
    const frameSel = panel.querySelector('#bb-frame');
    if (frameSel) frameSel.onchange = () => { systemFrame = parseInt(frameSel.value, 10) || 0; };

    const cbRate = panel.querySelector('#bb-ratebackoff');
    if (cbRate) cbRate.onchange = () => {
      rateLimitBackoff = cbRate.checked;
      logMsg('限流自动暂停 → ' + (rateLimitBackoff ? '开' : '关（默认）'));
    };

    const cbTitle = panel.querySelector('#bb-title');
    if (cbTitle) cbTitle.onchange = () => { titleFromName = cbTitle.checked; buildMatch(); renderMatch(); };

    const cbSpace = panel.querySelector('#bb-spacehide');
    if (cbSpace) cbSpace.onchange = () => { spaceHide = cbSpace.checked; };

    const cbTs = panel.querySelector('#bb-ts');
    if (cbTs) cbTs.onchange = () => { stripTimestamp = cbTs.checked; buildMatch(); renderMatch(); };

    const introInp = panel.querySelector('#bb-intro');
    if (introInp) introInp.oninput = () => { introText = introInp.value; };
    const fanInp = panel.querySelector('#bb-fan');
    if (fanInp) fanInp.oninput = () => { fanText = fanInp.value; };

    const catInp = panel.querySelector('#bb-category');
    if (catInp) catInp.oninput = () => { categoryWant = catInp.value.trim(); };

    panel.querySelectorAll('input[name="bb-privacy"]').forEach((r) => {
      r.onchange = () => { if (r.checked) { privacyWant = r.value; renderSummary(); logMsg('可见范围 → ' + privacyWant); } };
    });
    renderSummary();
    setInterval(renderSummary, 1500);

    const cbWait = panel.querySelector('#bb-wait-upload');
    if (cbWait) cbWait.onchange = () => { waitUploadDone = cbWait.checked; };

    // 【新增】一键包含哪些项
    panel.querySelectorAll('.bb-run-opt').forEach((cb) => {
      cb.onchange = () => { runOpts[cb.dataset.k] = cb.checked; };
    });

    // 手动改绑封面
    body.addEventListener('change', (e) => {
      const s = e.target.closest('.bb-bind');
      if (!s) return;
      manualBind[s.dataset.key] = s.value;
      buildMatch();
      renderMatch();
    });
    // ↑↑↑ 【新增 5】↑↑↑

    body.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      switch (action) {
        case 'setAll': await processAllTasks(); break;
        case 'setCover': await pickCover(); break;
        case 'pickCovers': pickCovers(true); break;        // 【新增】
        case 'pickFolder': pickFolder(); break;            // 【新增】
        case 'setDeclaration': await processDeclarationOnly(); break;
        case 'setPrivacy': await processPrivacyOnly(); break;
        case 'setTags': await processTagsOnly(); break;
        case 'clearCover': clearCover(); break;
        case 'abort': abortFlag = true; break;
        case 'batchSubmit': await processBatchSubmit(); break;
        case 'spaceHide': await processSpaceHideToggle(true); break;
        case 'spaceHideOff': await processSpaceHideToggle(false); break;
        case 'onlyTitle': await processSimpleOnly('title'); break;
        case 'onlyCover': await processSimpleOnly('cover'); break;
        case 'allThenSubmit': await processAllThenSubmit(); break;   // 【新增】
      }
    });

    // 【新增：预设 + 自动上传】接线
    initPresetBar(panel);
    initAutoUpload(panel);
    // 同步自动上传的独立设置（勾选=启用）
    body.addEventListener('change', (e) => {
      const t = e.target;
      try {
        if (t && t.classList && t.classList.contains('bb-auto-opt')) {
          if (t.dataset && t.dataset.k) autoSettings.runOpts[t.dataset.k] = t.checked;
        } else if (t && t.name === 'bb-auto-cover') {
          autoSettings.coverMode = t.value;
        } else if (t && t.name === 'bb-auto-privacy') {
          autoSettings.privacy = t.value;
        }
      } catch (err) { /* 忽略 */ }
    });
    const autoSeason = body.querySelector('#bb-auto-season');
    if (autoSeason) autoSeason.addEventListener('change', () => {
      autoSettings.season = autoSeason.value;
      const g = body.querySelector('#bb-season');       // 同步到全局（一键/自动上传都读它）
      if (g) g.value = autoSeason.value;
    });
    const gSeason = body.querySelector('#bb-season');
    if (gSeason) gSeason.addEventListener('change', () => {
      autoSettings.season = gSeason.value;
      const a = body.querySelector('#bb-auto-season');
      if (a) a.value = gSeason.value;
    });
    // 标题：保留原名（默认）+ 自定义模板；自动上传用独立的一套
    const keepEl = body.querySelector('#bb-auto-keepname');
    if (keepEl) keepEl.addEventListener('change', () => { autoSettings.keepName = !!keepEl.checked; });
    const tplEl = body.querySelector('#bb-auto-title-tpl');
    if (tplEl) tplEl.addEventListener('input', () => { autoSettings.titleTpl = tplEl.value; });
    const gTpl = body.querySelector('#bb-title-tpl');
    if (gTpl) gTpl.addEventListener('input', () => { titleTpl = gTpl.value; });
    const skipEl = body.querySelector('#bb-auto-skip');
    if (skipEl) skipEl.addEventListener('change', () => {
      autoUp.skipUploaded = !!skipEl.checked;
      autoUp.publishedTitles = null;
      try { scanDrive(); } catch (e) { /* 忽略 */ }
    });
    const rbEl = body.querySelector('#bb-auto-ratebackoff');
    if (rbEl) rbEl.addEventListener('change', () => { autoSettings.rateBackoff = !!rbEl.checked; });
    const rfbEl = body.querySelector('#bb-auto-refreshbatch');
    if (rfbEl) rfbEl.addEventListener('change', () => { autoSettings.batchRefresh = !!rfbEl.checked; });
    const acEl = body.querySelector('#bb-auto-autoconfirm');
    if (acEl) acEl.addEventListener('change', () => {
      autoSettings.autoConfirm = !!acEl.checked;
      logMsg('提前授权 → ' + (acEl.checked ? '开（提交不再弹确认框）' : '关（每批提交前弹确认）'));
    });
    // 【2.3】强制同步稿件 + 排除明细
    const syncBtn = body.querySelector('#bb-archive-sync');
    if (syncBtn) syncBtn.addEventListener('click', async () => {
      if (ArchiveSyncManager.running) { notify('同步进行中…', 'warning'); return; }
      notify('正在全量同步稿件…', 'info');
      logMsg('[同步] 强制全量同步开始…');
      const st = await ArchiveSyncManager.syncAll({ force: true });
      if (st.ok) {
        logMsg('[同步] 完成：读到 ' + st.readCount + ' 条 / ' + st.pages + ' 页'
          + (st.partial ? '（只读到前 ' + st.pages + ' 页，未完整）' : ''));
        notify('同步完成 ' + st.readCount + ' 条', 'success');
      } else {
        logMsg('[同步] 失败：' + (st.error || '未知') + '（不会把旧数据当最新）');
        notify('同步失败: ' + st.error, 'error');
      }
      autoUp.publishedTitles = null;
      try { scanDrive(); } catch (e) { /* 忽略 */ }
      renderArchiveReport();
    });
    const detBtn = body.querySelector('#bb-archive-detail');
    if (detBtn) detBtn.addEventListener('click', () => {
      const el = document.getElementById('bb-archive-rows');
      if (!el) return;
      const open = el.style.display !== 'none';
      el.style.display = open ? 'none' : 'block';
      detBtn.textContent = open ? '看排除明细' : '收起明细';
      if (!open) renderArchiveRows();
    });
    // 【2.3】多管线
    const pipeStart = body.querySelector('#bb-pipe-start');
    if (pipeStart) pipeStart.addEventListener('click', () => {
      const sel = body.querySelector('#bb-pipe-count');
      startMultiPipeline(parseInt((sel && sel.value) || '2', 10));
    });
    const pipeStop = body.querySelector('#bb-pipe-stop');
    if (pipeStop) pipeStop.addEventListener('click', () => { stopAllPipelines(); });
    const retryBtn = body.querySelector('#bb-auto-retry');
    if (retryBtn) retryBtn.addEventListener('click', () => { retryQueue(); });
  }

  /** 面板摘要：把「设成什么」写清楚，避免只有一个勾 */
  function renderSummary() {
    const el = document.getElementById('bb-summary');
    if (!el) return;
    const modeTxt = ({ match: '按文件名匹配', single: '全部同一张', system: '系统推荐第 ' + (systemFrame + 1) + ' 张', none: '不设封面' })[coverMode] || coverMode;
    const poolTxt = selectedCoverFile ? ('已选本地图 ' + selectedCoverFile.name)
      : (coverPool.length ? ('封面池 ' + coverPool.length + ' 张') : '尚未选图');
    el.innerHTML =
      '<div><b>可见范围</b> → ' + privacyWant + '</div>' +
      '<div><b>创作声明</b> → 内容无需标注</div>' +
      '<div><b>分区</b> → 保持B站自动分区</div>' +
      '<div><b>标签</b> → 推荐标签' + (customTags.trim() ? (' ＋ ' + customTags.trim()) : '') + '</div>' +
      '<div><b>封面</b> → ' + modeTxt + '（' + poolTxt + '）</div>' +
      '<div><b>空间隐藏</b> → 在个人空间-投稿中隐藏：开</div>';
  }

  /** 仅标题 / 仅封面 共用 */
  async function processSimpleOnly(kind) {
    const tasks = getTasks();
    if (!tasks.length) { notify('未找到视频任务', 'error'); return; }
    processing = true; abortFlag = false; disableButtons(true);
    let ok = 0, fail = 0;
    logMsg('==== ' + (kind === 'title' ? '仅标题' : '仅封面') + ' ====');
    try {
      for (let i = 0; i < tasks.length && !abortFlag; i++) {
      if (!isCurrentInstance()) { abortFlag = true; break; }   // 被新实例接管，旧实例退出
        selectTask(tasks[i]); await waitFor(() => !!document.querySelector('input[placeholder*="标题"], .bcc-select-input-inner, .check-radio-v2-container'), 800, 60);
        let r = false;
        if (kind === 'title') {
          buildMatch(); renderMatch();
          const row = taskRowBind.get(tasks[i]) || matchMap[i];
          r = await setTitleFromFilename((row && row.title) || tasks[i].getAttribute('title') || '');
        } else {
          // 【修复】旧版「仅封面」压根没有按文件名匹配的分支，只会用固定单图 / 系统推荐
          if (coverMode === 'system') r = await setCoverSystem(systemFrame);
          else if (coverMode === 'single' && selectedCoverFile) r = await setCover(selectedCoverFile);
          else {
            buildMatch();
            const row = taskRowBind.get(tasks[i]) || matchMap[i];
            const c = coverById(row && row.coverId);
            if (c) { logMsg('  按文件名匹配 → ' + c.file.name); r = await setCover(c.file); }
            else { r = false; logMsg('  [WARN] 没匹配到封面'); }
          }
        }
        r ? ok++ : fail++;
        await delay(60);
      }
    } catch (e) { logMsg('  [ERROR] ' + e.message); }
    finally {
      processing = false; disableButtons(false); hideProgress();
      logMsg('==== 结束：成功 ' + ok + '，失败 ' + fail + ' ====');
      notify('完成: 成功' + ok + ', 失败' + fail, fail > 0 ? 'warning' : 'success');
    }
  }

  function makeDraggable(panel) {
    const header = panel.querySelector('#bili-batch-header');
    if (!header) return;
    let d = false, sx, sy, sl, st;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      d = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); sl = r.left; st = r.top;
      panel.style.transition = 'none'; document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!d) return;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = (sl + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, st + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!d) return; d = false; panel.style.transition = ''; document.body.style.userSelect = '';
    });
  }

  function showProgress(cur, total, text) {
    const w = document.getElementById('bili-batch-progress');
    if (w) w.style.display = 'block';
    const b = document.getElementById('bili-batch-progress-bar');
    if (b) b.style.width = Math.round((cur / total) * 100) + '%';
    const t = document.getElementById('bili-batch-progress-text');
    if (t) t.textContent = text;
  }

  function hideProgress() {
    const w = document.getElementById('bili-batch-progress');
    if (w) w.style.display = 'none';
  }

  function disableButtons(v) {
    document.querySelectorAll('.bili-act').forEach(b => { b.disabled = v; b.style.opacity = v ? '0.5' : '1'; });
  }

  // ===========================
  // 封面选择
  // ===========================

  async function pickCover() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/jpeg,image/png,image/bmp,image/webp';
    input.style.display = 'none'; document.body.appendChild(input);

    const got = new Promise((resolve, reject) => {
      input.onchange = (e) => {
        const f = e.target.files[0];
        if (!f) reject(new Error('未选择文件'));
        else if (f.size > 5 * 1024 * 1024) reject(new Error('图片不能超过 5MB'));
        else resolve(f);
      };
    });

    input.click();
    try {
      const file = await got;
      input.remove();
      selectedCoverFile = file;

      // 【新增】用原版这个绿色按钮选图 = 全部用同一张，自动切模式，避免和「按文件名匹配」打架
      coverMode = 'single';
      document.querySelectorAll('input[name="bb-mode"]').forEach((r) => { r.checked = (r.value === 'single'); });
      buildMatch();
      renderMatch();

      const reader = new FileReader();
      reader.onload = (e) => {
        document.getElementById('bili-batch-cover-img').src = e.target.result;
        document.getElementById('bili-batch-cover-preview').style.display = 'block';
      };
      reader.readAsDataURL(file);
      logMsg('已选封面: ' + file.name + ' (' + (file.size / 1024).toFixed(0) + 'KB)');
      notify('封面: ' + file.name, 'success');
    } catch (err) {
      input.remove();
      notify(err.message, 'error');
    }
  }

  function clearCover() {
    selectedCoverFile = null;
    const p = document.getElementById('bili-batch-cover-preview');
    if (p) p.style.display = 'none';
    const img = document.getElementById('bili-batch-cover-img');
    if (img) img.src = '';
    logMsg('已清除封面');
    notify('已清除', 'info');
  }

  // ===========================
  // 初始化
  // ===========================

  function init() {
    if (!document.body) { setTimeout(init, 500); return; }
    const oldPanel = document.getElementById('bili-batch-panel');
    if (oldPanel) oldPanel.remove();   // 【修复】重复注入时先清掉旧面板/旧状态
    const style = document.createElement('style');
    style.textContent = `
      @keyframes bbfi { from { opacity:0; transform:translateY(-10px); } to { opacity:1; transform:translateY(0); } }
      .bili-act:hover { filter: brightness(1.15); }
    `;
    document.head.appendChild(style);
    createPanel();

    // 【新增】调试钩子：可在 Console 单独测某一步（__bb.setCover(file) / __bb.rows）
    try {
      window.__bb = {
        setCover: setCover,
        notify: notify,
        renderAuto: renderAuto,
        rateLimitHit: rateLimitHit,
        backoffIfLimited: backoffIfLimited,
        setCoverSystem: setCoverSystem,
        setTitleFromFilename: setTitleFromFilename,
        setSpaceHide: setSpaceHide,
        setCheckboxByLabel: setCheckboxByLabel,
        setQuillText: setQuillText,
        setSchedule: setSchedule,
        setToggleByText_row: setToggleByText_row,
        setSeason: setSeason,
        autoSettings: autoSettings,
        autoUp: autoUp,
        ArchiveSyncManager: ArchiveSyncManager,
        renderArchiveReport: renderArchiveReport,
        startMultiPipeline: startMultiPipeline,
        stopAllPipelines: stopAllPipelines,
        renderPipeStatus: renderPipeStatus,
        splitArray: splitArray,
        workerIndex: workerIndex,
        loadPipeline: loadPipeline,
        loadShard: loadShard,
        loadShardDone: loadShardDone,
        scanDrive: scanDrive,
        fillCoversUntilDone: fillCoversUntilDone,
        buildMatch: buildMatch,
        addCovers: addCovers,
        getMatchMap: function () { return matchMap; },
        getCoverPool: function () { return coverPool; },
        setTitleFromFilename: setTitleFromFilename,
        fetchSeasonList: fetchSeasonList,
        setCustomTags: setCustomTags,
        processAllTasks: processAllTasks,
        setDeclaration: setDeclaration,
        setPrivacy: setPrivacy,
        setTagsAuto: setTagsAuto,
        setCategoryIfNeeded: setCategoryIfNeeded,
        setCover: setCover,
        buildMatch: buildMatch,
        get rows() { return matchMap; },
        get pool() { return coverPool; },
      };
    } catch (e) { logMsg('[HOOK] 调试钩子设置失败: ' + (e && e.message ? e.message : e)); }

    // 延迟检测：Vue 渲染 .task 元素可能需要时间
    let retries = 0;
    function tryUpdateStats() {
      const count = updateStats();
      if (count === 0 && retries < 20) {
        retries++;
        setTimeout(tryUpdateStats, 500);
      } else {
        // 【新增】任务出来后顺便生成一次匹配表
        buildMatch();
        renderMatch();
        logMsg('哔哩哔哩投稿流水线 3.5 已启动');
        logMsg('检测到 ' + count + ' 个视频任务');
        logMsg('封面来源：按文件名匹配 → 选文件夹或选图片，标题会自动沿用文件名');
        logMsg('处理期间请勿操作鼠标');
      }
    }
    tryUpdateStats();
  }

  function updateStats() {
    const tasks = getTasks();
    const el = document.getElementById('bili-batch-stats');
    if (el) el.textContent = '检测到 ' + tasks.length + ' 个视频任务';
    return tasks.length;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
