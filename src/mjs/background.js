/**
 * background.js
 */

import {
  CONTENT_GET, CONTENT_SCRIPT_PATH, CONTEXT_MENU, EDITOR_CONFIG_GET,
  EDITOR_CONFIG_RES, EDITOR_CONFIG_TS, EDITOR_EXEC, EDITOR_FILE_NAME,
  EDITOR_LABEL, ENABLE_PB, EXT_NAME, EXT_RELOAD, FILE_EXT, FILE_EXT_PATH,
  HOST, HOST_CONNECTION, HOST_ERR_NOTIFY, HOST_STATUS, HOST_STATUS_GET,
  HOST_VERSION, HOST_VERSION_CHECK, ICON, ICON_AUTO, ICON_BLACK, ICON_COLOR,
  ICON_DARK, ICON_DARK_ID, ICON_ID, ICON_LIGHT, ICON_LIGHT_ID, ICON_WHITE,
  IS_ENABLED, IS_EXECUTABLE, IS_WEBEXT, KEY_ACCESS, LIVE_EDIT, LIVE_EDIT_PATH,
  LOCAL_FILE_VIEW, MENU_ENABLED, MODE_EDIT, MODE_MATHML, MODE_SELECTION,
  MODE_SOURCE, MODE_SVG, NS_URI, NS_URI_PATH, ONLY_EDITABLE, OPTIONS_OPEN,
  PORT_CONTENT, PROCESS_CHILD, STORAGE_SET, SYNC_AUTO, SYNC_AUTO_URL,
  THEME_DARK, THEME_LIGHT, TMP_FILES, TMP_FILES_PB, TMP_FILES_PB_REMOVE,
  TMP_FILE_CREATE, TMP_FILE_DATA_PORT, TMP_FILE_DATA_REMOVE, TMP_FILE_GET,
  TMP_FILE_REQ, TMP_FILE_RES, VARS_SET, WARN_COLOR, WARN_TEXT, WEBEXT_ID,
} from "./constant.js";
import {
  isString, logError, logMsg, logWarn, removeQueryFromURI, stringifyPositiveInt,
  throwErr,
} from "./common.js";
import {
  checkIncognitoWindowExists, clearNotification, createNotification,
  execScriptToExistingTabs, fetchData, getActiveTab, getActiveTabId,
  getAllStorage, getAllNormalWindows, getEnabledTheme, getStorage, setStorage,
} from "./browser.js";
import {migrateStorage} from "./migrate.js";

/* api */
const {
  browserAction, commands, contextMenus, i18n, notifications, runtime, storage,
  tabs, windows,
} = browser;

/* constants */
const HOST_VERSION_MIN = "v3.3.1";

/* variables */
const vars = {
  [IS_ENABLED]: false,
  [IS_WEBEXT]: runtime.id === WEBEXT_ID,
  [ONLY_EDITABLE]: false,
  [SYNC_AUTO]: false,
  [SYNC_AUTO_URL]: null,
};

const varsLocal = {
  [EDITOR_LABEL]: "",
  [ENABLE_PB]: false,
  [ICON_ID]: "",
  [IS_EXECUTABLE]: false,
  [KEY_ACCESS]: "U",
  [MENU_ENABLED]: false,
  [MODE_MATHML]: "",
  [MODE_SOURCE]: "",
  [MODE_SVG]: "",
};

/* native application host */
const host = runtime.connectNative(HOST);

/* host status */
const hostStatus = {
  [HOST_CONNECTION]: false,
  [HOST_VERSION]: false,
};

/**
 * port message to host
 * @param {*} msg - message
 * @returns {void}
 */
const portHostMsg = async msg => {
  msg && host && host.postMessage(msg);
};

/* local storage */
/**
 * fetch shared data and store
 * @param {string} path - data path
 * @param {string} key - local storage key
 * @returns {?AsyncFunction} - set local storage
 */
const storeFetchedData = async (path, key) => {
  let func;
  if (isString(key)) {
    const data = await fetchData(path);
    func = setStorage({[key]: data});
  }
  return func || null;
};

/* content ports collection */
const ports = new Map();

/**
 * create ports map
 * @param {string} windowId - window ID
 * @param {string} tabId - tabId
 * @returns {Object} - Map
 */
const createPortsMap = (windowId, tabId) => {
  if (!ports.has(windowId)) {
    ports.set(windowId, new Map());
  }
  const portsWin = ports.get(windowId);
  if (!portsWin.has(tabId)) {
    portsWin.set(tabId, new Map());
  }
  return portsWin.get(tabId);
};

/**
 * restore ports collection
 * @param {Object} data - disconnected port data
 * @returns {?AsyncFunction} - restore ports (recursive)
 */
const restorePorts = async (data = {}) => {
  const {tabId, windowId} = data;
  let func;
  if (windowId && tabId && ports.has(windowId)) {
    const portsWin = ports.get(windowId);
    portsWin.delete(tabId);
    if (portsWin.size === 0) {
      func = restorePorts({windowId});
    }
  } else {
    windowId && ports.delete(windowId);
  }
  return func || null;
};

/**
 * remove port from ports collection
 * @param {!Object} port - removed port
 * @returns {?AsyncFunction} - portHostMsg
 */
const removePort = async (port = {}) => {
  const {sender} = port;
  let func;
  if (sender) {
    const {tab, url} = sender;
    if (tab) {
      const portUrl = removeQueryFromURI(url);
      const {hostname} = new URL(portUrl);
      const {incognito} = tab;
      const {windowId: wId, id: tId} = tab;
      const windowId = stringifyPositiveInt(wId, true);
      const tabId = stringifyPositiveInt(tId, true);
      if (tabId && windowId && portUrl && ports.has(windowId)) {
        const portsWin = ports.get(windowId);
        if (portsWin.has(tabId)) {
          const portsTab = portsWin.get(tabId);
          portsTab.delete(portUrl);
          func = portHostMsg({
            [TMP_FILE_DATA_REMOVE]: {
              tabId, windowId,
              dir: incognito && TMP_FILES_PB || TMP_FILES,
              host: hostname,
            },
          });
        }
      }
    }
  }
  return func || null;
};

/**
 * port message
 * @param {*} msg - message
 * @param {string} windowId - windowId
 * @param {string} tabId - tabId
 * @returns {void}
 */
const portMsg = async (msg, windowId, tabId) => {
  if (msg) {
    const portsWin = ports.get(windowId);
    const portsTab = portsWin && portsWin.get(tabId);
    if (portsTab) {
      const portUrls = portsTab && portsTab.entries();
      for (const portUrl of portUrls) {
        const [key, port] = portUrl;
        try {
          port && port.postMessage(msg);
        } catch (e) {
          portsTab.delete(key);
        }
      }
    } else if (portsWin) {
      const tabIds = portsWin.keys();
      for (tabId of tabIds) {
        if (tabId) {
          portMsg(msg, windowId, tabId);
        }
      }
    } else {
      const windowIds = ports.keys();
      for (windowId of windowIds) {
        if (windowIds) {
          portMsg(msg, windowId);
        }
      }
    }
  }
};

/**
 * port context menu data
 * @param {!Object} info - contextMenus.OnClickData
 * @param {!Object} tab - tabs.Tab
 * @returns {void}
 */
const portContextMenuData = async (info, tab) => {
  const {frameUrl, pageUrl} = info;
  const {windowId: wId, id: tId} = tab;
  const windowId = stringifyPositiveInt(wId, true);
  const tabId = stringifyPositiveInt(tId, true);
  if (windowId && tabId) {
    const portUrl = removeQueryFromURI(frameUrl || pageUrl);
    const portsWin = ports.get(windowId);
    const portsTab = portsWin && portsWin.get(tabId);
    const port = portsTab && portsTab.get(portUrl);
    port && port.postMessage({
      [CONTENT_GET]: {info, tab},
    });
  }
};

/**
 * port tmp file data message
 * @param {string} key - message key
 * @param {*} msg - message
 * @returns {AsyncFunction} - port message
 */
const portTmpFileDataMsg = async (key, msg) => {
  let func;
  if (isString(key) && msg) {
    const {data} = msg;
    if (data) {
      const {tabId, windowId} = data;
      if (isString(tabId) && /^\d+$/.test(tabId) &&
          isString(windowId) && /^\d+$/.test(windowId)) {
        const activeTabId = await getActiveTabId(windowId * 1);
        if (activeTabId === tabId * 1) {
          func = portMsg({[key]: msg}, windowId, tabId);
        }
      }
    }
  }
  return func || null;
};

/**
 * port get content message to active tab
 * @returns {?AsyncFunction} - port msg
 */
const portGetContentMsg = async () => {
  let func;
  const tab = await getActiveTab();
  if (tab) {
    const {id: tId, windowId: wId} = tab;
    const windowId = stringifyPositiveInt(wId, true);
    const tabId = stringifyPositiveInt(tId, true);
    const msg = {
      [CONTENT_GET]: {tab},
    };
    func = portMsg(msg, windowId, tabId);
  }
  return func || null;
};

/**
 * restore content script
 * @returns {?AsyncFunction} - execScriptToExistingTabs()
 */
const restoreContentScript = async () => {
  let func;
  if (vars[IS_WEBEXT]) {
    func = execScriptToExistingTabs(CONTENT_SCRIPT_PATH, true);
  }
  return func || null;
};

/* icon */
/**
 * set icon
 * @param {string} id - icon fragment id
 * @returns {AsyncFunction} - set icon
 */
const setIcon = async (id = varsLocal[ICON_ID]) => {
  const icon = await runtime.getURL(ICON);
  const path = vars[IS_ENABLED] && `${icon}${id}` || `${icon}#off`;
  return browserAction.setIcon({path});
};

/**
 * toggle badge
 * @returns {Promise.<Array>} - results of each handler
 */
const toggleBadge = async () => {
  let color, text;
  if (hostStatus[HOST_CONNECTION] && hostStatus[HOST_VERSION] &&
      varsLocal[IS_EXECUTABLE]) {
    color = [0, 0, 0, 0];
    text = "";
  } else {
    color = WARN_COLOR;
    text = WARN_TEXT;
  }
  return Promise.all([
    browserAction.setBadgeBackgroundColor({color}),
    browserAction.setBadgeText({text}),
  ]);
};

/**
 * set default icon
 * @returns {void}
 */
const setDefaultIcon = async () => {
  const items = await getEnabledTheme();
  if (Array.isArray(items) && items.length) {
    for (const item of items) {
      const {id: themeId} = item;
      switch (themeId) {
        case THEME_DARK: {
          varsLocal[ICON_ID] = ICON_LIGHT_ID;
          break;
        }
        case THEME_LIGHT: {
          varsLocal[ICON_ID] = ICON_DARK_ID;
          break;
        }
        default: {
          if (vars[IS_WEBEXT]) {
            varsLocal[ICON_ID] = ICON_DARK_ID;
          } else {
            varsLocal[ICON_ID] = "";
          }
        }
      }
    }
  }
};

/* context menu */
/* context menu items collection */
const menus = {
  [MODE_SOURCE]: null,
  [MODE_SELECTION]: null,
  [MODE_EDIT]: null,
};

// TODO: implement accesskey, Issue #18
/**
 * create context menu item
 * @param {string} id - menu item ID
 * @param {Array} contexts - contexts
 * @returns {void}
 */
const createMenuItem = async (id, contexts) => {
  const label = varsLocal[EDITOR_LABEL] || i18n.getMessage(EXT_NAME);
  const accKey = !vars[IS_WEBEXT] && varsLocal[KEY_ACCESS] &&
                 `(&${varsLocal[KEY_ACCESS].toUpperCase()})` || "";
  const enabled = !!varsLocal[MENU_ENABLED] && !!varsLocal[IS_EXECUTABLE];
  if (isString(id) && menus.hasOwnProperty(id) && Array.isArray(contexts)) {
    menus[id] = await contextMenus.create({
      id, contexts, enabled,
      title: i18n.getMessage(id, [label, accKey]),
    });
  }
};

/**
 * create context menu items
 * @returns {Promise.<Array>} - results of each handler
 */
const createMenuItems = async () => {
  const win = await windows.getCurrent();
  const enabled = win && (!win.incognito || varsLocal[ENABLE_PB]) || false;
  const bool = enabled && !vars[ONLY_EDITABLE];
  const items = Object.keys(menus);
  const func = [];
  for (const item of items) {
    menus[item] = null;
    switch (item) {
      case MODE_EDIT:
        enabled && func.push(createMenuItem(item, ["editable"]));
        break;
      case MODE_SELECTION:
        bool && func.push(createMenuItem(item, ["selection"]));
        break;
      case MODE_SOURCE:
        bool && func.push(createMenuItem(item, ["frame", "page"]));
        break;
      default:
    }
  }
  return Promise.all(func);
};

/**
 * restore context menu
 * @returns {AsyncFunction} - create menu items
 */
const restoreContextMenu = async () =>
  contextMenus.removeAll().then(createMenuItems);

/**
 * update context menu
 * @param {Object} type - context type data
 * @returns {Promise.<Array>} - results of each handler
 */
const updateContextMenu = async type => {
  const func = [];
  if (type) {
    const items = Object.entries(type);
    if (items.length) {
      for (const item of items) {
        const [key, value] = item;
        const {enabled, menuItemId, mode} = value;
        if (menus[menuItemId]) {
          if (key === MODE_SOURCE) {
            const title = varsLocal[mode] || varsLocal[menuItemId];
            title && func.push(contextMenus.update(menuItemId, {title}));
          } else if (key === MODE_EDIT) {
            func.push(contextMenus.update(menuItemId, {enabled}));
          }
        }
      }
    }
  } else {
    const items = Object.keys(menus);
    const label = varsLocal[EDITOR_LABEL] || i18n.getMessage(EXT_NAME);
    const accKey = !vars[IS_WEBEXT] && varsLocal[KEY_ACCESS] &&
                   `(&${varsLocal[KEY_ACCESS].toUpperCase()})` || "";
    const enabled = !!varsLocal[MENU_ENABLED] && !!varsLocal[IS_EXECUTABLE];
    const bool = enabled && !vars[ONLY_EDITABLE];
    if (items.length) {
      for (const item of items) {
        if (menus[item]) {
          func.push(contextMenus.update(item, {
            enabled,
            title: i18n.getMessage(item, [label, accKey]),
          }));
        } else if (enabled) {
          switch (item) {
            case MODE_EDIT:
              func.push(createMenuItem(item, ["editable"]));
              break;
            case MODE_SELECTION:
              bool && func.push(createMenuItem(item, ["selection"]));
              break;
            case MODE_SOURCE:
              bool && func.push(createMenuItem(item, ["frame", "page"]));
              break;
            default:
          }
        }
      }
    }
  }
  return Promise.all(func);
};

/**
 * cache localized context menu item title
 * @returns {void}
 */
const cacheMenuItemTitle = async () => {
  const items = [MODE_SOURCE, MODE_MATHML, MODE_SVG];
  const label = varsLocal[EDITOR_LABEL] || i18n.getMessage(EXT_NAME);
  const accKey = !vars[IS_WEBEXT] && varsLocal[KEY_ACCESS] &&
                 `(&${varsLocal[KEY_ACCESS].toUpperCase()})` || "";
  for (const item of items) {
    varsLocal[item] = i18n.getMessage(item, [label, accKey]);
  }
};

/* UI */
/**
 * synchronize UI components
 * @returns {Promise.<Array>} - results of each handler
 */
const syncUI = async () => {
  const win = await windows.getCurrent();
  const enabled = win && (!win.incognito || varsLocal[ENABLE_PB]) || false;
  vars[IS_ENABLED] = !!enabled;
  return Promise.all([
    portMsg({[IS_ENABLED]: !!enabled}),
    setIcon(!enabled && "#off" || varsLocal[ICON_ID]),
    toggleBadge(),
  ]);
};

/* editor config */
/**
 * extract editor config data
 * @param {Object} data - editor config data
 * @returns {Promise.<Array>} - results of each handler
 */
const extractEditorConfig = async (data = {}) => {
  const {editorConfigTimestamp, editorName, executable} = data;
  const store = await getStorage([
    EDITOR_FILE_NAME,
    EDITOR_LABEL,
  ]);
  const editorFileName = store[EDITOR_FILE_NAME] &&
                           store[EDITOR_FILE_NAME].value;
  const editorLabel = store[EDITOR_LABEL] && store[EDITOR_LABEL].value;
  const editorNewLabel = editorFileName === editorName && editorLabel ||
                         executable && editorName || "";
  const msg = {
    [EDITOR_CONFIG_TS]: {
      id: EDITOR_CONFIG_TS,
      app: {
        executable: !!executable,
      },
      checked: false,
      value: editorConfigTimestamp || 0,
    },
    [EDITOR_FILE_NAME]: {
      id: EDITOR_FILE_NAME,
      app: {
        executable: !!executable,
      },
      checked: false,
      value: executable && editorName || "",
    },
    [EDITOR_LABEL]: {
      id: EDITOR_LABEL,
      app: {
        executable: false,
      },
      checked: false,
      value: editorNewLabel,
    },
  };
  const func = [
    setStorage(msg),
    portMsg({
      [EDITOR_CONFIG_RES]: {
        editorConfigTimestamp, editorName, executable,
        editorLabel: editorNewLabel,
      },
    }),
    restoreContextMenu(),
  ];
  return Promise.all(func);
};

/* extension */
/**
 * reload extension
 * @param {boolean} reload - reload
 * @returns {void}
 */
const reloadExt = async (reload = false) => {
  if (reload) {
    host && host.disconnect();
    runtime.reload();
  }
};

/* handlers */
/**
 * open options page
 * @returns {?AsyncFunction} - open options page
 */
const openOptionsPage = async () =>
  vars[IS_ENABLED] && runtime.openOptionsPage() || null;

/**
 * handle host message
 * @param {Object} msg - message
 * @returns {Promise.<Array>} - result of each handler
 */
const handleHostMsg = async msg => {
  const {message, status} = msg;
  const log = message && `${HOST}: ${message}`;
  const iconUrl = await runtime.getURL(ICON);
  const notifyMsg = {
    iconUrl, message,
    title: `${HOST}: ${status}`,
    type: "basic",
  };
  const func = [];
  switch (status) {
    case `${PROCESS_CHILD}_stderr`:
    case "error":
      log && func.push(logError(log));
      notifications && func.push(createNotification(status, notifyMsg));
      break;
    case "ready":
      hostStatus[HOST_CONNECTION] = true;
      func.push(
        portHostMsg({
          [EDITOR_CONFIG_GET]: true,
          [HOST_VERSION_CHECK]: HOST_VERSION_MIN,
        })
      );
      break;
    case "warn":
      log && func.push(logWarn(log));
      notifications && func.push(createNotification(status, notifyMsg));
      break;
    default:
      log && func.push(logMsg(log));
  }
  return Promise.all(func);
};

/**
 * handle message
 * @param {*} msg - message
 * @returns {Promise.<Array>} - results of each handler
 */
const handleMsg = async msg => {
  const func = [];
  const items = msg && Object.entries(msg);
  if (items && items.length) {
    for (const item of items) {
      const [key, value] = item;
      if (value) {
        switch (key) {
          case CONTEXT_MENU:
            func.push(updateContextMenu(value));
            break;
          case EDITOR_CONFIG_GET:
          case LOCAL_FILE_VIEW:
          case TMP_FILE_CREATE:
          case TMP_FILE_GET:
            func.push(portHostMsg({[key]: value}));
            break;
          case EDITOR_CONFIG_RES:
            func.push(extractEditorConfig(value));
            break;
          case EXT_RELOAD:
            func.push(reloadExt(!!value));
            break;
          case HOST:
            func.push(handleHostMsg(value));
            break;
          case HOST_STATUS_GET:
            func.push(portMsg({[HOST_STATUS]: hostStatus}));
            break;
          case HOST_VERSION: {
            const {result} = value;
            if (Number.isInteger(result)) {
              hostStatus[HOST_VERSION] = result >= 0;
              func.push(toggleBadge());
            }
            break;
          }
          case OPTIONS_OPEN:
            func.push(openOptionsPage());
            break;
          case STORAGE_SET:
            func.push(setStorage(value));
            break;
          case TMP_FILE_DATA_PORT:
            func.push(portMsg({[key]: value}));
            break;
          case TMP_FILE_DATA_REMOVE:
          case TMP_FILE_RES:
            func.push(portTmpFileDataMsg(key, value));
            break;
          default:
        }
      }
    }
  }
  return Promise.all(func);
};

/**
 * handle connected port
 * @param {Object} port - runtime.Port
 * @returns {void}
 */
const handlePort = async (port = {}) => {
  const {name: portName, sender} = port;
  const {frameId, tab, url} = sender;
  let func;
  if (tab) {
    const {active, incognito, status} = tab;
    const {windowId: wId, id: tId} = tab;
    const windowId = stringifyPositiveInt(wId, true);
    const tabId = stringifyPositiveInt(tId, true);
    if (windowId && tabId && url) {
      const portsTab = createPortsMap(windowId, tabId);
      const portUrl = removeQueryFromURI(url);
      port.onDisconnect.addListener(p => removePort(p).catch(throwErr));
      port.onMessage.addListener(msg => handleMsg(msg).catch(throwErr));
      portsTab.set(portUrl, port);
      port.postMessage({
        incognito, tabId, windowId,
        [VARS_SET]: vars,
      });
    }
    if (portName === PORT_CONTENT && frameId === 0 && active &&
        status === "complete") {
      varsLocal[MENU_ENABLED] = true;
      func = updateContextMenu();
    }
  }
  return func || null;
};

/**
 * handle disconnected host
 * @returns {AsyncFunction} - toggle badge
 */
const handleDisconnectedHost = async () => {
  hostStatus[HOST_CONNECTION] = false;
  return toggleBadge();
};

/**
 * handle tab activated
 * @param {!Object} info - activated tab info
 * @returns {Promise.<Array>} - results of each handler
 */
const onTabActivated = async info => {
  const func = [];
  const {tabId: tId, windowId: wId} = info;
  const windowId = stringifyPositiveInt(wId, true);
  const tabId = stringifyPositiveInt(tId, true);
  let bool;
  if (windowId && tabId) {
    const portsWin = ports.get(windowId);
    const portsTab = portsWin && portsWin.get(tabId);
    const items = portsTab && portsTab.values();
    if (items) {
      for (const item of items) {
        if (item) {
          const {name} = item;
          if (name) {
            bool = name === PORT_CONTENT;
            break;
          }
        }
      }
      if (bool) {
        func.push(portMsg({
          [TMP_FILE_REQ]: bool,
        }, windowId, tabId));
      }
    }
  }
  varsLocal[MENU_ENABLED] = bool || false;
  func.push(
    updateContextMenu(),
    syncUI(),
  );
  return Promise.all(func);
};

/**
 * handle tab updated
 * @param {!number} id - tabId
 * @param {!Object} info - changed tab info
 * @param {!Object} tab - tabs.Tab
 * @returns {Promise.<Array>} - results of each handler
 */
const onTabUpdated = async (id, info, tab) => {
  const {active, url, windowId: wId} = tab;
  const {status} = info;
  const windowId = stringifyPositiveInt(wId, true);
  const tabId = stringifyPositiveInt(id, true);
  const func = [];
  if (active) {
    const portUrl = removeQueryFromURI(url);
    const portsWin = ports.get(windowId);
    const portsTab = portsWin && portsWin.get(tabId);
    const port = portsTab && portsTab.get(portUrl);
    if (port) {
      const {name} = port;
      varsLocal[MENU_ENABLED] = name === PORT_CONTENT;
    } else {
      varsLocal[MENU_ENABLED] = false;
    }
    status === "complete" && func.push(updateContextMenu(), syncUI());
  }
  return Promise.all(func);
};

/**
 * handle tab removed
 * @param {!number} id - tabId
 * @param {!Object} info - removed tab info
 * @returns {Promise.<Array>} - results of each handler
 */
const onTabRemoved = async (id, info) => {
  const func = [];
  const {windowId: wId} = info;
  const {incognito} = await windows.get(wId);
  const windowId = stringifyPositiveInt(wId, true);
  const tabId = stringifyPositiveInt(id, true);
  const portsWin = ports.get(windowId);
  const portsTab = portsWin && portsWin.get(tabId);
  if (portsTab) {
    func.push(
      restorePorts({windowId, tabId}),
      portHostMsg({
        [TMP_FILE_DATA_REMOVE]: {
          tabId, windowId,
          dir: incognito && TMP_FILES_PB || TMP_FILES,
        },
      }),
    );
  }
  return Promise.all(func);
};

/**
 * handle window focus changed
 * @param {number} id - window ID
 * @returns {Promise.<Array>} - results of each handler
 */
const onWindowFocusChanged = async id => {
  const func = [];
  const winArr = await getAllNormalWindows();
  const tId = await getActiveTabId(id);
  const windowId = stringifyPositiveInt(id, true);
  const tabId = stringifyPositiveInt(tId, true);
  if (windowId && tabId) {
    func.push(portMsg({
      [TMP_FILE_REQ]: true,
    }, windowId, tabId));
  }
  if (winArr) {
    for (const win of winArr) {
      const {focused, type} = win;
      if (focused && type === "normal") {
        func.push(restoreContextMenu());
        break;
      }
    }
  }
  func.push(syncUI());
  return Promise.all(func);
};

/**
 * handle window removed
 * @param {!number} windowId - windowId
 * @returns {Promise.<Array>} - results of each handler
 */
const onWindowRemoved = async windowId => {
  const func = [];
  const winArr = await getAllNormalWindows();
  if (winArr && winArr.length) {
    const bool = await checkIncognitoWindowExists();
    !bool && func.push(portHostMsg({[TMP_FILES_PB_REMOVE]: !bool}));
    windowId = stringifyPositiveInt(windowId, true);
    windowId && func.push(restorePorts({windowId}));
  }
  return Promise.all(func);
};

/**
 * handle command
 * @param {string} cmd - command
 * @returns {?AsyncFunction} - command handler function
 */
const handleCmd = async cmd => {
  let func;
  if (isString(cmd)) {
    switch (cmd) {
      case EDITOR_EXEC:
        func = portGetContentMsg();
        break;
      case OPTIONS_OPEN:
        func = openOptionsPage();
        break;
      default:
    }
  }
  return func || null;
};

/* handle variables */
/**
 * port variable
 * @param {Object} v - variable
 * @returns {?AsyncFunction} - port message
 */
const portVar = async v => v && portMsg({[VARS_SET]: v}) || null;

/**
 * set variable
 * @param {string} item - item
 * @param {Object} obj - value object
 * @param {boolean} changed - changed
 * @returns {Promise.<Array>} - results of each handler
 */
const setVar = async (item, obj, changed = false) => {
  const func = [];
  if (item && obj) {
    const {app, checked, value} = obj;
    const hasPorts = ports.size > 0;
    switch (item) {
      case EDITOR_FILE_NAME:
        varsLocal[item] = value;
        varsLocal[IS_EXECUTABLE] = app && !!app.executable;
        changed && func.push(toggleBadge());
        break;
      case EDITOR_LABEL:
        varsLocal[item] = value;
        func.push(cacheMenuItemTitle());
        changed && func.push(updateContextMenu());
        break;
      case ENABLE_PB:
        varsLocal[item] = !!checked;
        changed && func.push(syncUI());
        break;
      case HOST_ERR_NOTIFY:
        if (checked && notifications && notifications.onClosed &&
            !notifications.onClosed.hasListener(clearNotification)) {
          notifications.onClosed.addListener(clearNotification);
        }
        break;
      case ICON_AUTO:
      case ICON_BLACK:
      case ICON_COLOR:
      case ICON_DARK:
      case ICON_LIGHT:
      case ICON_WHITE:
        if (checked) {
          varsLocal[ICON_ID] = value;
          changed && func.push(setIcon(value));
        }
        break;
      case KEY_ACCESS:
        varsLocal[item] = value;
        changed && func.push(
          updateContextMenu(),
          cacheMenuItemTitle(),
        );
        break;
      case ONLY_EDITABLE:
        vars[item] = !!checked;
        hasPorts && func.push(portVar({[item]: !!checked}));
        changed && func.push(restoreContextMenu());
        break;
      case SYNC_AUTO:
        vars[item] = !!checked;
        hasPorts && func.push(portVar({[item]: !!checked}));
        break;
      case SYNC_AUTO_URL:
        vars[item] = value;
        hasPorts && func.push(portVar({[item]: value}));
        break;
      default:
    }
  }
  return Promise.all(func);
};

/**
 * set variables
 * @param {Object} data - data
 * @returns {Promise.<Array>} - results of each handler
 */
const setVars = async (data = {}) => {
  const func = [];
  const items = Object.entries(data);
  if (items.length) {
    for (const item of items) {
      const [key, value] = item;
      const {newValue} = value;
      func.push(setVar(key, newValue || value, !!newValue));
    }
  }
  return Promise.all(func);
};

/* listeners */
browserAction.onClicked.addListener(() => openOptionsPage().catch(throwErr));
commands.onCommand.addListener(cmd => handleCmd(cmd).catch(throwErr));
contextMenus.onClicked.addListener((info, tab) =>
  portContextMenuData(info, tab).catch(throwErr)
);
host.onDisconnect.addListener(port =>
  handleDisconnectedHost(port).then(toggleBadge).catch(throwErr)
);
host.onMessage.addListener(msg => handleMsg(msg).catch(throwErr));
runtime.onConnect.addListener(port => handlePort(port).catch(throwErr));
runtime.onMessage.addListener(msg => handleMsg(msg).catch(throwErr));
storage.onChanged.addListener(data =>
  setVars(data).then(syncUI).catch(throwErr)
);
tabs.onActivated.addListener(info => onTabActivated(info).catch(throwErr));
tabs.onUpdated.addListener((id, info, tab) =>
  onTabUpdated(id, info, tab).catch(throwErr)
);
tabs.onRemoved.addListener((id, info) =>
  onTabRemoved(id, info).catch(throwErr)
);
windows.onFocusChanged.addListener(windowId =>
  onWindowFocusChanged(windowId).catch(throwErr)
);
windows.onRemoved.addListener(windowId =>
  onWindowRemoved(windowId).catch(throwErr)
);

/* startup */
Promise.all([
  setDefaultIcon().then(getAllStorage).then(setVars).then(restoreContentScript)
    .then(syncUI),
  storeFetchedData(NS_URI_PATH, NS_URI),
  storeFetchedData(FILE_EXT_PATH, FILE_EXT),
  storeFetchedData(LIVE_EDIT_PATH, LIVE_EDIT),
  migrateStorage(),
]).catch(throwErr);
