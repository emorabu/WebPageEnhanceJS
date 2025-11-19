// ==UserScript==
// @name         禁止自动播放
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Try to block autoplay for audio/video on pages
// @author       You
// @match        https://x.com/*
// @grant        none
// ==/UserScript==
/* 然后粘上上面的主脚本体 */

// ====== 禁止视频自动播放脚本 ======
(function () {
  'use strict';

  // 允许播放的短时用户交互窗口（毫秒）
  const USER_GESTURE_WINDOW = 1200;

  // 保存原生 play 函数
  const nativePlay = HTMLMediaElement.prototype.play;

  // 最近一次用户交互时间
  let lastUserGestureTs = 0;

  // 当发生用户交互时调用
  function markUserGesture() {
    lastUserGestureTs = Date.now();
  }

  // 监听常见的用户交互事件
  ['click', 'mousedown', 'mouseup', 'keydown', 'touchstart', 'pointerdown'].forEach(evt => {
    window.addEventListener(evt, markUserGesture, { capture: true, passive: true });
  });

  // 判断当前触发播放是否来自用户操作窗口内
  function hasRecentUserGesture() {
    return (Date.now() - lastUserGestureTs) <= USER_GESTURE_WINDOW;
  }

  // 拦截 play()：如果不是用户触发且媒体元素带有 autoplay 属性或正在尝试自动播放，则拒绝
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      const el = this;
      const wantsAutoplay = el.autoplay || el.getAttribute('autoplay') !== null;

      if (!hasRecentUserGesture() && wantsAutoplay) {
        // 模拟浏览器对自动播放阻止的行为：返回一个被拒绝的 Promise（与某些浏览器行为一致）
        return Promise.reject(new DOMException('Playback prevented by user script (autoplay blocked)', 'NotAllowedError'));
      }

      // 如果没有 autoplay，但页面脚本强行调用 .play()，也按同样规则处理（避免非用户触发的脚本播放）
      if (!hasRecentUserGesture()) {
        return Promise.reject(new DOMException('Playback prevented by user script (no user gesture)', 'NotAllowedError'));
      }

      // 否则调用原生 play
      return nativePlay.apply(this, args);
    } catch (err) {
      // 安全兜底：若有什么异常则调用原生 play（尽力保证不破坏页面）
      return nativePlay.apply(this, args);
    }
  };

  // 对当前页面已有的媒体元素做处理：移除 autoplay 属性并暂停
  function processMediaElement(el) {
    try {
      if (el.hasAttribute && el.hasAttribute('autoplay')) {
        el.removeAttribute('autoplay');
      }
      // 某些媒体可能已经在播放，若没有用户手势则尝试暂停
      if (!hasRecentUserGesture()) {
        if (!el.paused) {
          try { el.pause(); } catch (e) { /* ignore */ }
        }
      }
      // 防止媒体在元数据加载后自动开始播放
      el.addEventListener('play', function onPlay(e) {
        if (!hasRecentUserGesture()) {
          try { el.pause(); } catch (ex) {}
        }
      }, { capture: true });
    } catch (e) {
      // ignore element we can't access
    }
  }

  // 初始扫描页面
  function initialScan() {
    const medias = Array.from(document.querySelectorAll('video, audio'));
    medias.forEach(processMediaElement);

    // 尝试修正 iframe 中的常见 autoplay 参数（best-effort）
    const iframes = Array.from(document.querySelectorAll('iframe[src]'));
    iframes.forEach(iframe => {
      try {
        const src = iframe.getAttribute('src') || '';
        // 常见痕迹: youtube、vimeo、autoplay=1 等，替换 autoplay=1 -> autoplay=0，或添加参数
        if (src.includes('autoplay=1')) {
          iframe.setAttribute('src', src.replace(/autoplay=1/g, 'autoplay=0'));
        } else if (/youtube|vimeo|player/.test(src) && !/[?&]autoplay=/.test(src)) {
          // 如果是 youtube/vimeo 并且没有 autoplay 参数，添上 autoplay=0（不会对某些托管策略生效，但可以尝试）
          const separator = src.includes('?') ? '&' : '?';
          iframe.setAttribute('src', src + separator + 'autoplay=0');
        }
      } catch (e) {
        // 无法修改跨域 iframe 的某些属性时忽略
      }
    });
  }

  // 观察动态插入的媒体元素
  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      // 新增节点
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(node => {
          if (!(node instanceof Element)) return;
          if (node.matches && (node.matches('video') || node.matches('audio'))) {
            processMediaElement(node);
          }
          // 若动态插入容器，查询其内部媒体
          node.querySelectorAll && node.querySelectorAll('video, audio').forEach(processMediaElement);
          // 尝试处理 iframe
          if (node.matches && node.matches('iframe')) {
            try {
              const src = node.getAttribute('src') || '';
              if (src.includes('autoplay=1')) {
                node.setAttribute('src', src.replace(/autoplay=1/g, 'autoplay=0'));
              } else if (/youtube|vimeo|player/.test(src) && !/[?&]autoplay=/.test(src)) {
                const separator = src.includes('?') ? '&' : '?';
                node.setAttribute('src', src + separator + 'autoplay=0');
              }
            } catch (e) {}
          }
        });
      }

      // attributes 改变（有人添加了 autoplay 属性）
      if (m.type === 'attributes' && (m.target.matches && (m.target.matches('video') || m.target.matches('audio')))) {
        processMediaElement(m.target);
      }
    }
  });

  mo.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['autoplay', 'src']
  });

  // 首次运行
  try {
    initialScan();
  } catch (e) {
    // ignore
  }

  // 提示（方便调试）
  console.info('Autoplay blocker: active — media autoplay and non-user-initiated .play() are blocked (best-effort).');

  // 可选：在 window 上暴露一个轻量 API，方便临时允许播放（例如调试时）
  window.__autoplayBlocker = {
    allowOnceFor: function (ms = 1000) {
      lastUserGestureTs = Date.now() + ms; // 给予短时“用户手势”窗口
    },
    disable: function () {
      // 恢复原始 play（谨慎使用）
      HTMLMediaElement.prototype.play = nativePlay;
      mo.disconnect();
      console.info('Autoplay blocker: disabled.');
    }
  };

})();
