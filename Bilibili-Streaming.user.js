// ==UserScript==
// @name         矫正 b 站自动连播按钮 - 分P、合集、单视频、番剧（影片）开关分别独立
// @namespace    http://maxchang.me
// @version      0.3.6
// @description  关于我不想要哔哩哔哩自动连播只想在分 P 中跳转但是阿 b 把他们混为一谈这件事。
// @author       MaxChang3
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

// 自定义 logger
const logger = {
    prefix: '%c📺 [AutoPlay-Fix]',
    style: 'background: #00a1d6; color: white; padding: 2px 4px; border-radius: 3px;',
    lastLog: null,
    log: function (msg, ...args) {
        const currentLog = JSON.stringify([msg, args]);
        if (this.lastLog === currentLog) return;
        this.lastLog = currentLog;
        console.log(this.prefix, this.style, msg, ...args);
    },
    error: function (msg, ...args) {
        console.error(this.prefix, this.style, msg, ...args);
    }
}

const type = {
    VIDEO: 'video',
    MULTIPART: 'multipart',
    COLLECTION: 'collection',
    PLAYLIST: 'playlist',
    BANGUMI: 'bangumi',
}

// --- 番剧 (Bangumi) 专用逻辑 Start ---

// 检查番剧是否是最后一集 (纯 DOM)
const checkBangumiLastEpisode = () => {
    const nextBtn = document.querySelector('.bpx-player-ctrl-next');
    if (!nextBtn) return true; // 按钮不存在，默认最后一集
    // 检查禁用状态
    if (nextBtn.classList.contains('bpx-state-disabled') || nextBtn.getAttribute('disabled') !== null) {
        return true;
    }
    return false;
};

// 番剧静默修改设置 (模拟点击)
const setBangumiHandoff = (enable) => {
    const targetVal = enable ? 0 : 2; // 0: Auto, 2: Stop
    let needUIAction = false;

    // 1. 检查 LocalStorage (作为是否需要点击的参考)
    try {
        const profile = JSON.parse(localStorage.getItem('bpx_player_profile') || '{}');
        const currentHandoff = profile.media?.handoff;
        if (currentHandoff !== targetVal) {
            needUIAction = true;
            // 尝试预先写入 LS，虽然页面不刷新可能不生效，但保持数据一致性
            if (!profile.media) profile.media = {};
            profile.media.handoff = targetVal;
            localStorage.setItem('bpx_player_profile', JSON.stringify(profile));
        }
    } catch (e) {
        needUIAction = true;
    }

    if (!needUIAction) {
        logger.log(`Bangumi: 状态已是 ${enable ? '开启' : '关闭'}，无需操作`);
        return;
    }

    // 2. 执行静默点击
    const settingBtn = document.querySelector('.bpx-player-ctrl-setting');
    if (!settingBtn) {
        logger.log('Bangumi: 未找到设置按钮，无法操作');
        return;
    }

    // 避让用户
    const existingMenu = document.querySelector('.bpx-player-ctrl-setting-menu');
    if (existingMenu) {
        // 只有当鼠标真正悬停在菜单内容上，或焦点在菜单内时，才视为用户正在操作
        // 仅仅悬停在按钮上（导致菜单显示）不视为操作，允许脚本接管
        const isHovered = existingMenu.matches(':hover');
        const isFocused = existingMenu.contains(document.activeElement);
        if (isHovered || isFocused) {
            logger.log('Bangumi: 用户正在操作菜单，跳过');
            return;
        }
    }

    // 注入隐藏样式
    const styleId = 'correct-next-btn-hide-menu';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = `
            .bpx-player-ctrl-setting-menu {
                opacity: 0 !important;
                visibility: hidden !important;
                pointer-events: none !important;
                display: block !important; 
            }
        `;
        document.head.appendChild(styleEl);
    }

    // 触发菜单
    settingBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    settingBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    setTimeout(() => {
        const targetText = enable ? '自动切集' : '播完暂停';
        let radioItems = document.querySelectorAll('.bpx-player-ctrl-setting-handoff .bui-radio-item');
        if (radioItems.length === 0) {
            radioItems = document.querySelectorAll('.bpx-player-ctrl-setting-menu .bui-radio-item');
        }

        let found = false;
        for (const item of radioItems) {
            const text = item.textContent?.trim();
            if (text === targetText) {
                found = true;
                const input = item.querySelector('input');
                if (input && !input.checked) {
                    item.click();
                    logger.log(`Bangumi: 已静默点击切换为 [${targetText}]`);
                }
                break;
            }
        }
        if (!found) logger.log(`Bangumi: 菜单中未找到 [${targetText}]`);

        // 清理
        settingBtn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        setTimeout(() => {
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        }, 200);
    }, 300);
};

// --- 番剧 (Bangumi) 专用逻辑 End ---


// --- 普通视频 (Vue) 逻辑 Start ---
let globalApp = null;

const handleVuePage = () => {
    if (!globalApp) {
        // logger.error('globalApp is not available')
        return
    }
    const videoData = globalApp.videoData
    if (!videoData) {
        // logger.error('videoData is not available')
        return
    }
    const { videos: videosCount } = videoData
    const pageType =
        videosCount > 1
            ? type.MULTIPART
            : globalApp.isSection
                ? type.COLLECTION
                : globalApp.playlist?.type
                    ? type.PLAYLIST
                    : type.VIDEO

    const pageStatus = globalApp.continuousPlay
    const userStatus = GM_getValue(pageType)

    // 初始化或同步状态
    if (userStatus === undefined) {
        GM_setValue(pageType, pageStatus)
    } else if (pageStatus !== userStatus) {
        globalApp.setContinuousPlay(userStatus)
    }

    logger.log(`Vue Page (${pageType}):`, {
        current: pageStatus,
        target: userStatus
    })

    // 合集的最后一个视频不进行自动连播
    if (pageType === type.COLLECTION) {
        const currentBvid = globalApp.bvid
        const sections = globalApp.sectionsInfo?.sections
        const episodes = sections?.[0]?.episodes
        if (episodes && episodes.length > 0) {
            const lastBvid = episodes[episodes.length - 1]?.bvid
            if (currentBvid === lastBvid) {
                logger.log('Vue Page: 合集最后一个视频，强制关闭连播')
                globalApp.setContinuousPlay(false)
            }
        }
    }
}
// --- 普通视频 (Vue) 逻辑 End ---


// 主入口
const correctNextButton = () => {
    if (location.pathname.startsWith('/bangumi')) {
        // 番剧逻辑
        const userWant = GM_getValue(type.BANGUMI, true);
        const isLast = checkBangumiLastEpisode();
        const finalState = isLast ? false : userWant;

        if (isLast) logger.log('Bangumi: 检测到最后一集');

        setBangumiHandoff(finalState);
    } else {
        // 普通视频逻辑
        handleVuePage();
    }
}


// Vue Hook
let lastVueInstance = null
const hookVueInstance = (vueInstance) => {
    if (!vueInstance || vueInstance === lastVueInstance) return
    lastVueInstance = vueInstance
    globalApp = vueInstance
    correctNextButton()

    if (!vueInstance.__correctNextButtonHooked) {
        const __loadVideoData = vueInstance.loadVideoData
        vueInstance.loadVideoData = function () {
            return __loadVideoData.call(this).then(
                (res) => {
                    correctNextButton()
                    return res
                },
                (error) => Promise.reject(error)
            )
        }
        vueInstance.__correctNextButtonHooked = true
    }
}

const observeVueInstance = () => {
    // 番剧页面：轮询 URL 和 DOM
    if (location.pathname.startsWith('/bangumi')) {
        logger.log('Bangumi Mode Activated');
        // 初始延迟执行
        setTimeout(correctNextButton, 2500);

        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                logger.log('Bangumi: URL 变化，重新检测...');
                setTimeout(correctNextButton, 2000);
            }
        }, 2000);
        return;
    }

    // 普通页面：MutationObserver
    const appContainer = document.querySelector('#app')
    if (!appContainer) return
    if (appContainer.__vue__) {
        hookVueInstance(appContainer.__vue__)
    }
    const observer = new MutationObserver(() => {
        const app = document.querySelector('#app')
        if (app?.__vue__) {
            hookVueInstance(app.__vue__)
        }
    })
    observer.observe(appContainer, { childList: true, subtree: true })
}

const registerMenuCommands = () => {
    Object.entries(type).forEach(([key, value]) => {
        const status = GM_getValue(value)
        // 默认为开启 (undefined or true)
        const isEnabled = status !== false;
        const statusText = isEnabled ? '✅ 开启' : '❌ 关闭'
        const typeMap = {
            [type.VIDEO]: '单视频',
            [type.MULTIPART]: '分P',
            [type.COLLECTION]: '合集',
            [type.PLAYLIST]: '收藏列表',
            [type.BANGUMI]: '番剧',
        }
        GM_registerMenuCommand(`${typeMap[value]} 连播: ${statusText}`, () => {
            GM_setValue(value, !isEnabled)
            location.reload()
        })
    })
}

registerMenuCommands()
observeVueInstance()
