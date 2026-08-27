// ==UserScript==
// @name         矫正 b 站自动连播按钮 - 分P、合集、单视频、番剧（影片）开关分别独立
// @namespace    http://maxchang.me
// @version      0.6.0
// @description  关于我不想要哔哩哔哩自动连播只想在分 P 中跳转但是阿 b 把他们混为一谈这件事。
// @author       MaxChang3
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
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

// 各类型默认连播状态(首次使用 / 未设置时采用)
// 单视频 关闭, 分P 开启, 合集 开启, 收藏列表 关闭, 番剧 开启
const DEFAULT_STATUS = {
    [type.VIDEO]: false,
    [type.MULTIPART]: true,
    [type.COLLECTION]: true,
    [type.PLAYLIST]: false,
    [type.BANGUMI]: true,
}

// 存储版本号:升级后清除旧版本按“页面当前状态”写入的残留值,统一采用新默认值
const STORE_VERSION = '0.6.0'
const migrateStorage = () => {
    if (GM_getValue('__store_version') === STORE_VERSION) return
    Object.values(type).forEach((key) => GM_deleteValue(key))
    GM_setValue('__store_version', STORE_VERSION)
    logger.log('存储已重置,应用新的默认连播设置')
}

// --- 番剧 (Bangumi) 专用逻辑 Start ---

// 获取播放器内核,稳定 API:window.player.setHandoff() / getHandoff()
// 值语义:0=自动切集, 2=播完暂停
const HANDSET_AUTO = 0;
const HANDSET_STOP = 2;

const getBangumiPlayer = () => {
    // Tampermonkey 隔离世界读不到 window.player(页面主世界 JS 全局变量),
    // 必须经 unsafeWindow 访问页面主世界;非 Tampermonkey 环境回退到 window。
    const pageWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
    const player = pageWindow.player;
    return player && typeof player.getHandoff === 'function' && typeof player.setHandoff === 'function'
        ? player
        : null;
};

// 读取番剧当前切集状态 (通过 API,不再依赖 LocalStorage)
const getBangumiHandoff = () => {
    const player = getBangumiPlayer();
    if (!player) return HANDSET_AUTO;
    try {
        return player.getHandoff();
    } catch (e) {
        logger.error('Bangumi: getHandoff 异常', e);
        return HANDSET_AUTO;
    }
};

// 检查番剧是否是最后一集
// 用播放器「下一集」按钮的存在性/禁用态判定:中间集有可点的下一集按钮,最后一集按钮不存在或被禁用。
// 不依赖 URL 形态(ep/ss)或分集列表渲染时机,避免 SS 合辑、列表未渲染时的误判。
const checkBangumiLastEpisode = () => {
    const nextBtn = document.querySelector('.bpx-player-ctrl-next');
    const isLast = !nextBtn || nextBtn.classList.contains('bpx-state-disabled');
    if (isLast) logger.log('Bangumi: 无下一集按钮,判定为最后一集');
    return isLast;
};

// 番剧修改切集状态 (通过播放器 API,不再 DOM 模拟点击)
const setBangumiHandoff = (enable) => {
    const player = getBangumiPlayer();
    if (!player) {
        logger.log('Bangumi: 播放器 API 不可用,跳过');
        return;
    }

    const target = enable ? HANDSET_AUTO : HANDSET_STOP;
    let current;
    try {
        current = player.getHandoff();
        if (current === target) {
            logger.log(`Bangumi: 状态已是 ${enable ? '自动切集' : '播完暂停'},无需操作`);
            return;
        }
        player.setHandoff(target);
        logger.log(`Bangumi: 已通过 API 切换为 [${enable ? '自动切集' : '播完暂停'}]`);
    } catch (e) {
        logger.error('Bangumi: setHandoff 异常', e);
    }
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
    let userStatus = GM_getValue(pageType)

    // 首次使用:未设置时写入该类型默认值并应用
    if (userStatus === undefined) {
        userStatus = DEFAULT_STATUS[pageType] ?? pageStatus
        GM_setValue(pageType, userStatus)
    }

    // 若实际状态与用户期望不一致,则纠正
    if (pageStatus !== userStatus) {
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
        const userWant = GM_getValue(type.BANGUMI, DEFAULT_STATUS[type.BANGUMI]);
        const isLast = checkBangumiLastEpisode();
        const finalState = isLast ? false : userWant;

        if (isLast) logger.log('Bangumi: 检测到最后一集');

        setBangumiHandoff(finalState);
    } else if (location.pathname.startsWith('/list/')) {
        // 合集/追剧列表页:自身没有自动连播按钮,无操作
        logger.log('List Page: 列表页无自动连播逻辑,跳过');
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
    // 番剧页面:持续轮询校正连播状态(而非仅在 URL 变化时)
    // 播放器「下一集」按钮可能晚于页面加载出现,首次执行时可能误判为最后一集;
    // setBangumiHandoff 已有 current===target 短路,重复轮询不会重复写入。
    if (location.pathname.startsWith('/bangumi')) {
        logger.log('Bangumi Mode Activated');
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                logger.log('Bangumi: URL 变化,重新检测...');
            }
            correctNextButton();
        }, 2000);
        return;
    }

    // 合集/追剧列表页:同样轮询 URL(用于检测进入/离开)
    if (location.pathname.startsWith('/list/')) {
        logger.log('List Mode Activated');
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                correctNextButton();
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
        // 默认状态使用 DEFAULT_STATUS,未设置时按默认显示
        const isEnabled = status === undefined ? DEFAULT_STATUS[value] : status;
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

// 启动:先迁移存储(升级时重置旧残留值),再注册菜单、启动监听
migrateStorage()
registerMenuCommands()
observeVueInstance()
