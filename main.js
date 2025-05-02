const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const user_agents = require("./config/userAgents.js");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, isTokenExpired, saveJson } = require("./utils/utils.js");
const { checkBaseUrl } = require("./utils/checkAPI.js");
let intervalIds = [];
const localStorage = require("./localStorage.json");

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL) {
    this.headers = {
      Accept: "*/*",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "none",
      Origin: "chrome-extension://knnliglhgkmlblppdejchidfihjnockl",
      connection: "keep-alive",
      "content-type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    };
    this.baseURL = baseURL;
    this.baseURL_v2 = settings.BASE_URL_v2;

    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.authInfo = null;
    this.localStorage = localStorage;
    // this.wallet = getWalletFromPrivateKey(itemData.privateKey);
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.email;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Stork][Account ${this.accountIndex + 1}][${this.itemData.email}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 2,
      isAuth: false,
      extraHeaders: {},
      refreshToken: null,
    }
  ) {
    const { retries, isAuth, extraHeaders, refreshToken } = options;

    const headers = {
      ...this.headers,
      ...extraHeaders,
    };

    if (!isAuth) {
      headers["authorization"] = `Bearer ${this.token}`;
    }

    if (refreshToken) {
      headers["authorization"] = `Bearer ${refreshToken}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      errorMessage = null,
      errorStatus = 0;

    do {
      try {
        const response = await axios({
          method,
          url,
          headers,
          timeout: 120000,
          ...(proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent } : {}),
          ...(method.toLowerCase() != "get" ? { data } : {}),
        });
        if (response?.data?.data) return { status: response.status, success: true, data: response.data.data, error: null };
        return { success: true, data: response.data, status: response.status, error: null };
      } catch (error) {
        errorStatus = error.status;
        errorMessage = error?.response?.data?.message ? error?.response?.data : error.message;
        this.log(`Request failed: ${url} | Status: ${error.status} | ${JSON.stringify(errorMessage || {})}...`, "warning");

        if (error.status == 401) {
          this.log(`Unauthorized: ${url} | trying get new token...`);
          this.token = await this.getValidToken(true);
          return await this.makeRequest(url, method, data, options);
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errorMessage, data: null };
        }
        if (error.status == 429) {
          this.log(`Rate limit ${JSON.stringify(errorMessage)}, waiting 60s to retries`, "warning");
          await sleep(60);
        }
        if (currRetries > retries) {
          return { status: error.status, success: false, error: errorMessage, data: null };
        }
        currRetries++;
        await sleep(5);
      }
    } while (currRetries <= retries);
    return { status: errorStatus, success: false, error: errorMessage, data: null };
  }

  async login() {
    const payload = {
      email: this.itemData.email,
      password: this.itemData.password,
    };
    return this.makeRequest(`https://app-auth.jp.stork-oracle.network/token?grant_type=password`, "post", payload, { isAuth: true });
  }

  async getRefereshToken() {
    return this.makeRequest(
      `${this.baseURL}/auth/refresh`,
      "post",
      {
        refreshToken: this.authInfo.refreshToken,
      },
      {
        refreshToken: this.authInfo.refreshToken,
      }
    );
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/v1/me`, "get");
  }

  async getHash() {
    return this.makeRequest(`${this.baseURL}/v1/stork_signed_prices`, "get");
  }

  async validateHash(payload) {
    // { msg_hash: msg_hash, valid: true }
    return this.makeRequest(`${this.baseURL}/v1/stork_signed_prices/validations`, "post", payload);
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const { isExpired: isExp, expirationDate } = isTokenExpired(existingToken);

    this.log(`Access token status: ${isExp ? "Expired".yellow : "Valid".green} | Acess token exp: ${expirationDate}`);
    if (existingToken && !isNew && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    }

    // if (this.authInfo?.refreshToken) {
    //   const { isExpired: isExpRe, expirationDate: expirationDateRe } = isTokenExpired(this.authInfo.refreshToken);
    //   this.log(`RefereshToken token status: ${isExpRe ? "Expired".yellow : "Valid".green} | RefereshToken token exp: ${expirationDateRe}`);
    //   if (!isExpRe) {
    //     const result = await this.getRefereshToken();
    //     if (result.data?.access_token) {
    //       await saveJson(this.session_name, JSON.stringify(result.data), "localStorage.json");
    //       return result.data.access_token;
    //     }
    //   }
    // }

    this.log("No found token or experied, logining......", "warning");
    const loginRes = await this.login();
    if (!loginRes?.success) return null;
    const newToken = loginRes.data;
    if (newToken?.access_token) {
      await saveJson(this.session_name, JSON.stringify(newToken), "localStorage.json");
      return newToken.access_token;
    }
    this.log("Can't get new token...", "warning");
    return null;
  }

  async handleSyncData() {
    this.log(`Sync data...`);
    let userData = { success: true, data: null, status: 0, error: null },
      retries = 0;

    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 1 && userData.status !== 400);
    if (userData.success) {
      const { referral_code, stats } = userData.data;
      this.log(`Ref code: ${referral_code} | Invalid validate: ${stats?.stork_signed_prices_invalid_count || 0} | Total points: ${stats?.stork_signed_prices_valid_count || 0}`, "custom");
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async handleHB() {
    const result = await this.getHash();
    if (!result.success || !result.data) return this.log(`Can't get hash validate`, "warning");
    const keys = result.data;
    for (const key in keys) {
      if (key.includes("USD")) {
        const msg_hash = keys[key]?.timestamped_signature?.msg_hash;
        this.log(`Starting validate message hash: ${msg_hash}`);
        const res = await this.validateHash({
          msg_hash: msg_hash,
          valid: true,
        });
        if (res?.success && res?.data?.message == "ok") {
          this.log(`[${new Date().toLocaleString()}] Validate ${msg_hash} success!`, "success");
        } else {
          this.log(`[${new Date().toLocaleString()}] Validate ${msg_hash} failed! | ${JSON.stringify(res || {})}`, "warning");
        }
      }
    }
    this.log(`Waiting 5 minutes for next ping...`);
  }

  async runAccount() {
    this.session_name = this.itemData.email;
    this.authInfo = JSON.parse(this.localStorage[this.session_name] || "{}");
    this.token = this.authInfo?.access_token;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      this.log(`Bắt đầu sau ${timesleep} giây...`);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    await sleep(1);
    if (userData?.success) {
      const interValCheckPoint = setInterval(() => this.handleSyncData(), 30 * 60 * 1000);
      intervalIds.push(interValCheckPoint);
      if (settings.AUTO_MINING) {
        await this.handleHB();
        const interValHB = setInterval(() => this.handleHB(), settings.PING_INTERVAL * 1000);
        intervalIds.push(interValHB);
      }
    } else {
      this.log("Can't get user info...skipping", "error");
    }
  }
}

function stopInterVal() {
  if (intervalIds.length > 0) {
    for (const intervalId of intervalIds) {
      clearInterval(intervalId);
    }
    intervalIds = [];
  }
}

async function main() {
  console.clear();
  console.log(colors.yellow("\nTool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)"));

  const data = [];
  // loadData("privateKeys.txt");
  const accounts = loadData("accounts.txt");
  const proxies = loadData("proxy.txt");

  if (accounts.length == 0 || (accounts.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và accounts phải bằng nhau.".red);
    console.log(`Data: ${accounts.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }

  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint, message } = await checkBaseUrl();
  if (!endpoint) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);

  const itemDatas = accounts
    .map((val, index) => {
      const [email, password] = val.split("|");
      const item = {
        email: email,
        password: password,
        index,
      };
      return item;
    })
    .filter((i) => i !== null);

  process.on("SIGINT", async () => {
    console.log("Stopping...".yellow);
    stopInterVal();
    await sleep(1);
    process.exit();
  });

  await sleep(1);

  for (let i = 0; i < itemDatas.length; i += maxThreads) {
    const batch = itemDatas.slice(i, i + maxThreads);
    const promises = batch.map(async (itemData, indexInBatch) => {
      const accountIndex = i + indexInBatch;
      const proxy = proxies[accountIndex] || null;
      const client = new ClientAPI(itemData, accountIndex, proxy, endpoint);
      return client.runAccount();
    });
    await Promise.all(promises);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
