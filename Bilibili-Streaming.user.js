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

// 各类型默认连播状态(首次使用时写入):单视频/收藏列表关闭,分P/合集/番剧开启
const DEFAULT_STATUS = {
    [type.VIDEO]: false,
    [type.MULTIPART]: true,
    [type.COLLECTION]: true,
    [type.PLAYLIST]: false,
    [type.BANGUMI]: true,
}

// 存储版本号:升级时清除旧残留值,统一采用新默认值
const STORE_VERSION = '0.6.0'
const migrateStorage = () => {
    if (GM_getValue('__store_version') === STORE_VERSION) return
    Object.values(type).forEach((key) => GM_deleteValue(key))
    GM_setValue('__store_version', STORE_VERSION)
    logger.log('Startup: 存储已重置,应用默认连播设置')
}

// --- 番剧 (Bangumi) 专用逻辑 Start ---

// 播放器内核 API:window.player.getHandoff()/setHandoff(), 0=自动切集, 2=播完暂停
const HANDSET_AUTO = 0;
const HANDSET_STOP = 2;

// 隔离世界读不到 window.player,须经 unsafeWindow 访问页面主世界(非 Tampermonkey 回退 window)
const getBangumiPlayer = () => {
    const pageWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
    const player = pageWindow.player;
    return player && typeof player.getHandoff === 'function' && typeof player.setHandoff === 'function'
        ? player
        : null;
};

// 读取番剧当前切集状态
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

// 检查番剧是否为最后一集:中间集有可点的「下一集」按钮,末集按钮不存在或被禁用
const checkBangumiLastEpisode = () => {
    const nextBtn = document.querySelector('.bpx-player-ctrl-next');
    const isLast = !nextBtn || nextBtn.classList.contains('bpx-state-disabled');
    if (isLast) logger.log('Bangumi: 无下一集按钮,判定为最后一集');
    return isLast;
};

// 番剧修改切集状态(通过播放器 API)
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
        logger.log(`Bangumi: 已切换为 [${enable ? '自动切集' : '播完暂停'}]`);
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

    // 首次使用:未设置时写入默认值并应用
    if (userStatus === undefined) {
        userStatus = DEFAULT_STATUS[pageType] ?? pageStatus
        GM_setValue(pageType, userStatus)
    }

    // 状态与期望不一致则纠正
    if (pageStatus !== userStatus) {
        globalApp.setContinuousPlay(userStatus)
    }

    logger.log(`Vue (${pageType}):`, {
        current: pageStatus,
        target: userStatus
    })

    // 合集最后一个视频不自动连播
    if (pageType === type.COLLECTION) {
        const currentBvid = globalApp.bvid
        const sections = globalApp.sectionsInfo?.sections
        const episodes = sections?.[0]?.episodes
        if (episodes && episodes.length > 0) {
            const lastBvid = episodes[episodes.length - 1]?.bvid
            if (currentBvid === lastBvid) {
                logger.log('Vue: 合集最后一个视频，强制关闭连播')
                globalApp.setContinuousPlay(false)
            }
        }
    }
}
// --- 普通视频 (Vue) 逻辑 End ---


// 主入口
const correctNextButton = () => {
    if (location.pathname.startsWith('/bangumi')) {
        // 番剧逻辑:最后一集关连播,中间集按用户设置;返回播放器是否就绪
        if (!getBangumiPlayer()) return false;

        const userWant = GM_getValue(type.BANGUMI, DEFAULT_STATUS[type.BANGUMI]);
        const isLast = checkBangumiLastEpisode();
        const finalState = isLast ? false : userWant;

        if (isLast) logger.log('Bangumi: 检测到最后一集');

        setBangumiHandoff(finalState);
        return true;
    } else if (location.pathname.startsWith('/list/')) {
        // 列表播放页(「播放全部」进入):自身无连播按钮,直接经 unsafeWindow 调播放器 API 恒开连播
        // 返回能否拿到播放器,供轮询判断何时可以收工
        const pageWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        const player = pageWindow.player;
        if (!(player && typeof player.getHandoff === 'function' && typeof player.setHandoff === 'function')) {
            return false;
        }
        try {
            if (player.getHandoff() !== HANDSET_AUTO) {
                player.setHandoff(HANDSET_AUTO);
                logger.log('List: 已开启自动连播');
            }
        } catch (e) {
            logger.error('List: setHandoff 异常', e);
        }
        return true;
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
    // 番剧页面:每集重判最后一集(切集即 URL 变化)。轮询在播放器就绪后,仅切集时重判。
    if (location.pathname.startsWith('/bangumi')) {
        logger.log('Bangumi: 已启动轮询');
        let lastUrl = location.href;
        let ready = false;
        setInterval(() => {
            if (ready) {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    logger.log('Bangumi: URL 变化,重新检测...');
                    correctNextButton();
                }
            } else {
                ready = correctNextButton();
            }
        }, 2000);
        return;
    }

    // 列表播放页:待播放器就绪并设好连播后停止轮询(连播是全局设置,切集不重置)
    if (location.pathname.startsWith('/list/')) {
        logger.log('List: 已启动轮询');
        const timer = setInterval(() => {
            if (correctNextButton()) {
                clearInterval(timer);
                logger.log('List: 连播已设置,停止轮询');
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

// 启动:迁移存储、注册菜单、启动监听
migrateStorage()
registerMenuCommands()
observeVueInstance()
