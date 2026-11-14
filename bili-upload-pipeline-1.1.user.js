// ==UserScript==
// @name         哔哩哔哩投稿流水线 1.1
// @namespace    https://github.com/lhsheung/bili-upload-pipeline
// @version      1.1
// @description  PS5 游戏视频备份用：封面按原视频文件名精确匹配、批量设「仅自己可见」、失败项自动重试；不猜相似度、不等系统推荐帧
// @author       LauHingSheung
// @match        https://member.bilibili.com/platform/upload/video/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

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
  function notify(message, type) {
    const types = { success: '#52c41a', error: '#ff4d4f', info: '#1890ff', warning: '#faad14' };
    const el = document.createElement('div');
    el.textContent = `[投稿流水线] ${message}`;
    Object.assign(el.style, {
      position: 'fixed', top: '20px', right: '20px', zIndex: CONFIG.PANEL_Z_INDEX + 10,
      padding: '12px 20px', borderRadius: '6px', background: '#1e1e1e',
      color: types[type] || types.info, fontSize: '14px', fontWeight: '500',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.5s'; }, 3000);
    setTimeout(() => el.remove(), 3500);
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

  /** 命中限流就退避：2.5s → 再命中 6s；返回是否发生过退避 */
  async function backoffIfLimited() {
    if (!rateLimitBackoff) return false;   // 【默认关】不加不暂停，保持原速
    let hit = rateLimitHit();
    if (!hit) return false;
    logMsg('  [限流] B站提示「' + hit + '」→ 暂停 2.5s');
    await delay(2500);
    if (rateLimitHit()) {
      logMsg('  [限流] 仍在限流 → 再等 6s');
      await delay(6000);
    }
    return true;
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
  function buildMatch() {
    const tasks = getTasks();
    const used = {};
    const rows = [];
    tasks.forEach((el, i) => {
      const raw = getTaskTitle(el);
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
      const taken = new Set();
      // ① 第一轮：只认「原本文件名」完全一致（忽略扩展名 / 全角半角 / (1) 副本号）
      //    精确同名绝对优先，绝不会被近似匹配的图抢走
      rows.forEach((r) => {
        if (Object.prototype.hasOwnProperty.call(manualBind, r.key) || r.coverId) return;
        const want = normName(r.videoBase);
        if (!want) return;
        const cands = coverPool.filter((c) => !manualCovers.has(c.id) && !taken.has(c.id) && normName(c.name) === want);
        if (!cands.length) return;
        // 同名多图（同一个名字存了 16:9 和 4:3 两张）→ B站封面位是 16:9，优先挑比例最接近 16:9 的那张
        cands.sort((x, y) => {
          const rx = (x.w && x.h) ? Math.abs(x.w / x.h - 16 / 9) : 9;
          const ry = (y.w && y.h) ? Math.abs(y.w / y.h - 16 / 9) : 9;
          return rx - ry;
        });
        const hit = cands[0];
        r.coverId = hit.id; r.score = 1; r.exact = true; taken.add(hit.id);
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
    if (runOpts.title && titleFromName && row && row.title) {
      await setTitleFromFilename(row.title);
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
      coverOk = await setCover(selectedCoverFile);
    } else {
      const c = coverById(row && row.coverId);
      if (c) {
        logMsg('  按文件名匹配 → ' + c.file.name);
        coverOk = await setCover(c.file);
      } else {
        coverOk = false;
        logMsg('  [WARN] 该行没匹配到封面（不用单图兜底）');
      }
    }
    await backoffIfLimited();   // 这一项跑完若已被限流，先退避再做下一项
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
    const msg = '逐项投稿完成: 成功 ' + ok + '，失败 ' + fail;
    logMsg('==== ' + msg + ' ====');
    notify(msg, fail > 0 ? 'warning' : 'success');
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
      logMsg('==== 一键全部设置结束：成功 ' + ok + '，失败 ' + fail + ' ====');
      notify('完成: 成功 ' + ok + ', 失败 ' + fail, fail > 0 ? 'warning' : 'success');
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
    const box = row && row.querySelector('.bcc-checkbox');
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
  // UI
  // ===========================

  function createPanel() {
    const existing = document.getElementById('bili-batch-panel');
    if (existing) existing.remove();

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
        <span style="font-size:14px; font-weight:600;">哔哩哔哩投稿流水线 1.1</span>
        <div style="display:flex; gap:6px;">
          <button id="bili-batch-min" style="background:none; border:none; color:#fff; cursor:pointer; font-size:16px;">–</button>
          <button id="bili-batch-close" style="background:none; border:none; color:#fff; cursor:pointer; font-size:16px;">✕</button>
        </div>
      </div>
      <div id="bili-batch-body" style="padding:12px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px;">
        <div id="bili-batch-stats" style="font-size:12px; color:#999; text-align:center;"></div>
        <!-- ↓↓↓ 【新增 4】封面来源 / 标题规则 / 匹配表 ↓↓↓ -->
        <div style="border:1px solid #f0f0f0; border-radius:8px; padding:8px;">
          <div style="font-size:11px; color:#666; margin-bottom:5px;">封面来源</div>
          <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:12px;">
            <label><input type="radio" name="bb-mode" value="match" checked> 按文件名匹配</label>
            <label><input type="radio" name="bb-mode" value="single"> 全部同一张</label>
            <label><input type="radio" name="bb-mode" value="system"> 系统推荐封面</label>
            <label><input type="radio" name="bb-mode" value="none"> 不设</label>
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
            <label style="margin-left:6px; color:#ff4d4f;"><input type="checkbox" id="bb-spacehide" checked> 空间隐藏</label>
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
              <label><input type="checkbox" id="bb-ratebackoff"> 限流时自动暂停（默认关）</label>
            </div>
            <div style="border-top:1px dashed #eee;padding-top:6px;line-height:1.95;color:#444;">
              <div><b>可见范围</b>（页面真实只有这两项）：
                <label><input type="radio" name="bb-privacy" value="仅自己可见" checked> 仅自己可见</label>
                <label><input type="radio" name="bb-privacy" value="公开可见"> 公开可见</label>
              </div>
              <div><b>分区</b> → <span style="color:#888;">B站已自动分好，保持原分区（该页下拉打不开，不支持修改）</span></div>
              <div><b>标签</b> → 自动添加 B站推荐标签</div>
              <div><b>简介</b> <input type="text" id="bb-intro" placeholder="留空=不改" style="width:130px;font-size:11px;">
                   <b>粉丝动态</b> <input type="text" id="bb-fan" placeholder="留空=不改" style="width:130px;font-size:11px;"></div>
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
        <details style="font-size:10px;">
          <summary style="cursor:pointer; color:#999;">操作日志</summary>
          <div id="bili-batch-log" style="max-height:100px; overflow-y:auto; background:#f9f9f9; border-radius:4px; padding:6px; margin-top:4px; font-family:monospace; white-space:pre-wrap; word-break:break-all; color:#666;"></div>
        </details>
      </div>`;
    document.body.appendChild(panel);
    makeDraggable(panel);
    requestAnimationFrame(() => bindEvents(panel));
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
        rateLimitHit: rateLimitHit,
        backoffIfLimited: backoffIfLimited,
        setCoverSystem: setCoverSystem,
        setTitleFromFilename: setTitleFromFilename,
        setSpaceHide: setSpaceHide,
        setCheckboxByLabel: setCheckboxByLabel,
        setQuillText: setQuillText,
        setSchedule: setSchedule,
        setToggleByText_row: setToggleByText_row,
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
        logMsg('哔哩哔哩投稿流水线 1.1 已启动');
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
