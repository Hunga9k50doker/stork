import AmazonCognitoIdentity from "amazon-cognito-identity-js";
import axios from "axios";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import path from "path";
import { fileURLToPath } from "url";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { accounts } from "./accounts.js";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function randomDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function retryWithExponentialBackoff(fn, maxRetries = 5, initialDelay = 1000) {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries > maxRetries || (!error.message.includes("Too many requests") && !error.message.includes("timeout") && !error.message.includes("network") && !error.message.includes("429"))) {
        throw error;
      }

      const delay = initialDelay * Math.pow(2, retries) * (0.5 + Math.random());
      log(`Retrying after ${Math.round(delay / 1000)}s due to: ${error.message}`, "RETRY");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

class RateLimiter {
  constructor(maxConcurrent = 5, intervalMs = 1000) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.intervalMs = intervalMs;
    this.lastRequestTime = 0;
  }

  async schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.intervalMs) {
      setTimeout(() => this.processQueue(), this.intervalMs - timeSinceLastRequest);
      return;
    }

    this.running++;
    const { fn, resolve, reject } = this.queue.shift();
    this.lastRequestTime = Date.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      setTimeout(() => this.processQueue(), this.intervalMs);
    }
  }
}

const authRateLimiter = new RateLimiter(3, 2000);
const apiRateLimiter = new RateLimiter(10, 1000);

function loadConfig() {
  try {
    const configPath = path.join(__dirname, "config.json");

    if (!fs.existsSync(configPath)) {
      log(`Config file not found at ${configPath}, using default configuration`, "WARN");

      const defaultConfig = {
        cognito: {
          region: "ap-northeast-1",
          clientId: "5msns4n49hmg3dftp2tp1t2iuh",
          userPoolId: "ap-northeast-1_M22I44OpC",
        },
        stork: {
          intervalSeconds: 30,
          requestTimeoutMs: 30000,
          maxRetries: 5,
        },
        threads: {
          maxWorkers: 5,
          maxConcurrentAccounts: 10,
          accountBatchSize: 5,
          accountBatchDelayMs: 30000,
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf8");
      return defaultConfig;
    }

    const userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return userConfig;
  } catch (error) {
    log(`Error loading config: ${error.message}`, "ERROR");
    throw new Error("Failed to load configuration");
  }
}

const userConfig = loadConfig();
const config = {
  cognito: {
    region: userConfig.cognito?.region || "ap-northeast-1",
    clientId: userConfig.cognito?.clientId || "5msns4n49hmg3dftp2tp1t2iuh",
    userPoolId: userConfig.cognito?.userPoolId || "ap-northeast-1_M22I44OpC",
    username: userConfig.cognito?.username || "",
    password: userConfig.cognito?.password || "",
  },
  stork: {
    baseURL: "https://app-api.jp.stork-oracle.network/v1",
    authURL: "https://api.jp.stork-oracle.network/auth",
    tokenPath: path.join(__dirname, "tokens"),
    intervalSeconds: userConfig.stork?.intervalSeconds || 30,
    requestTimeoutMs: userConfig.stork?.requestTimeoutMs || 30000,
    maxRetries: userConfig.stork?.maxRetries || 5,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    origin: "chrome-extension://knnliglhgkmlblppdejchidfihjnockl",
  },
  threads: {
    maxWorkers: userConfig.threads?.maxWorkers || 5,
    maxConcurrentAccounts: userConfig.threads?.maxConcurrentAccounts || 10,
    accountBatchSize: userConfig.threads?.accountBatchSize || 5,
    accountBatchDelayMs: userConfig.threads?.accountBatchDelayMs || 30000,
    proxyFile: path.join(__dirname, "proxies.txt"),
  },
};

if (!fs.existsSync(config.stork.tokenPath)) {
  fs.mkdirSync(config.stork.tokenPath, { recursive: true });
}

function validateConfig() {
  if (accounts.length === 0) {
    log("ERROR: No accounts found in accounts.js", "ERROR");
    return false;
  }

  for (let i = 0; i < accounts.length; i++) {
    if (!accounts[i].username || !accounts[i].password) {
      log(`ERROR: Username and password must be set for account at index ${i}`, "ERROR");
      return false;
    }
  }
  return true;
}

const poolData = { UserPoolId: config.cognito.userPoolId, ClientId: config.cognito.clientId };
const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace("T", " ").substr(0, 19);
}

function getFormattedDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(
    2,
    "0"
  )}:${String(now.getSeconds()).padStart(2, "0")}`;
}

function log(message, type = "INFO") {
  let prefix = `[${getFormattedDate()}] [${type}]`;
  let newMess = "";
  switch (type) {
    case "WARN":
      newMess = chalk.yellow(`${prefix} ${message}`);
      break;
    case "ERROR":
      newMess = chalk.red(`${prefix} ${message}`);
      break;
    case "SUCCESS":
      newMess = chalk.green(`${prefix} ${message}`);
      break;
    case "CUSTOM":
      newMess = chalk.magenta(`${prefix} ${message}`);
      break;
    default:
      newMess = chalk.blue(`${prefix} ${message}`);
      break;
  }
  return console.log(newMess);
}

class CognitoAuth {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: username, Password: password });
    this.cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: username, Pool: userPool });
  }

  async authenticate() {
    return authRateLimiter.schedule(() => {
      return new Promise((resolve, reject) => {
        this.cognitoUser.authenticateUser(this.authenticationDetails, {
          onSuccess: (result) =>
            resolve({
              accessToken: result.getAccessToken().getJwtToken(),
              idToken: result.getIdToken().getJwtToken(),
              refreshToken: result.getRefreshToken().getToken(),
              expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now(),
            }),
          onFailure: (err) => reject(err),
          newPasswordRequired: () => reject(new Error("New password required")),
        });
      });
    });
  }

  async refreshSession(refreshToken) {
    return authRateLimiter.schedule(() => {
      const refreshTokenObj = new AmazonCognitoIdentity.CognitoRefreshToken({ RefreshToken: refreshToken });
      return new Promise((resolve, reject) => {
        this.cognitoUser.refreshSession(refreshTokenObj, (err, result) => {
          if (err) reject(err);
          else
            resolve({
              accessToken: result.getAccessToken().getJwtToken(),
              idToken: result.getIdToken().getJwtToken(),
              refreshToken: refreshToken,
              expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now(),
            });
        });
      });
    });
  }
}

class TokenManager {
  constructor(accountIndex) {
    this.accountIndex = accountIndex;
    this.username = accounts[accountIndex].username;
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.expiresAt = null;
    this.auth = new CognitoAuth(accounts[accountIndex].username, accounts[accountIndex].password);
    this.tokenFilePath = path.join(config.stork.tokenPath, `${this.username.replace(/@/g, "_at_")}.json`);
    this.retryCount = 0;
  }

  async getValidToken() {
    try {
      await this.loadTokensFromFile();

      if (!this.accessToken || this.isTokenExpired()) {
        await this.refreshOrAuthenticate();
      }

      return this.accessToken;
    } catch (error) {
      log(`Error getting valid token for ${this.username}: ${error.message}`, "ERROR");
      throw error;
    }
  }

  async loadTokensFromFile() {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        const tokensData = fs.readFileSync(this.tokenFilePath, "utf8");
        const tokens = JSON.parse(tokensData);

        if (tokens.accessToken && tokens.refreshToken && tokens.expiresAt) {
          this.accessToken = tokens.accessToken;
          this.refreshToken = tokens.refreshToken;
          this.idToken = tokens.idToken;
          this.expiresAt = tokens.expiresAt;
          log(`Loaded tokens from file for ${this.username}`);
        }
      }
    } catch (error) {
      log(`Error loading tokens from file for ${this.username}: ${error.message}`, "WARN");
    }
  }

  isTokenExpired() {
    return !this.expiresAt || Date.now() >= this.expiresAt;
  }

  async refreshOrAuthenticate() {
    try {
      let result;
      if (this.refreshToken) {
        try {
          result = await retryWithExponentialBackoff(() => this.auth.refreshSession(this.refreshToken), config.stork.maxRetries);
        } catch (error) {
          log(`Token refresh failed for ${this.username}, will try full authentication: ${error.message}`, "WARN");

          result = await retryWithExponentialBackoff(() => this.auth.authenticate(), config.stork.maxRetries);
        }
      } else {
        result = await retryWithExponentialBackoff(() => this.auth.authenticate(), config.stork.maxRetries);
      }
      await this.updateTokens(result);
    } catch (error) {
      log(`Token refresh/auth error for ${this.username}: ${error.message}`, "ERROR");
      throw error;
    }
  }

  async updateTokens(result) {
    this.accessToken = result.accessToken;
    this.idToken = result.idToken;
    this.refreshToken = result.refreshToken;
    this.expiresAt = Date.now() + result.expiresIn;

    const tokens = {
      accessToken: this.accessToken,
      idToken: this.idToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      isAuthenticated: true,
      isVerifying: false,
    };

    await this.saveTokensToFile(tokens);
    log(`Tokens updated for ${this.username}`);
  }

  async saveTokensToFile(tokens) {
    try {
      fs.writeFileSync(this.tokenFilePath, JSON.stringify(tokens, null, 2), "utf8");
      log(`Tokens saved to file for ${this.username}`);
      return true;
    } catch (error) {
      log(`Error saving tokens for ${this.username}: ${error.message}`, "WARN");
      return false;
    }
  }
}

class AccountProxyManager {
  constructor() {
    this.accountProxyMap = new Map();
    this.proxies = [];
    this.initialized = false;
  }

  loadProxies() {
    try {
      if (!fs.existsSync(config.threads.proxyFile)) {
        log(`Proxy file not found at ${config.threads.proxyFile}, creating empty file`, "WARN");
        fs.writeFileSync(config.threads.proxyFile, "", "utf8");
        return [];
      }

      const proxyData = fs.readFileSync(config.threads.proxyFile, "utf8");
      const proxies = proxyData
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      if (proxies.length === 0) {
        log("No valid proxies found in proxy file", "WARN");
        return [];
      }

      log(`Loaded ${proxies.length} proxies from ${config.threads.proxyFile}`);
      return proxies;
    } catch (error) {
      log(`Error loading proxies: ${error.message}`, "ERROR");
      return [];
    }
  }

  async initialize() {
    if (this.initialized) return;

    this.proxies = this.loadProxies();

    await this.assignProxiesToAccounts();

    this.saveProxyMappings();

    this.initialized = true;
    log(`Proxy manager initialized with ${this.accountProxyMap.size} account-proxy mappings`);
  }

  async assignProxiesToAccounts() {
    await this.loadProxyMappings();

    if (this.proxies.length === 0) {
      for (const account of accounts) {
        if (!this.accountProxyMap.has(account.username)) {
          this.accountProxyMap.set(account.username, null);
          log(`Account ${account.username} will use direct connection (no proxy)`);
        }
      }
      return;
    }

    const proxyUsage = new Map();
    for (const proxy of this.proxies) {
      proxyUsage.set(proxy, 0);
    }

    for (const [_, proxy] of this.accountProxyMap.entries()) {
      if (proxy && proxyUsage.has(proxy)) {
        proxyUsage.set(proxy, proxyUsage.get(proxy) + 1);
      }
    }

    for (const account of accounts) {
      if (!this.accountProxyMap.has(account.username)) {
        let leastUsedProxy = null;
        let minUsage = Infinity;

        for (const [proxy, count] of proxyUsage.entries()) {
          if (count < minUsage) {
            minUsage = count;
            leastUsedProxy = proxy;
          }
        }

        if (leastUsedProxy) {
          this.accountProxyMap.set(account.username, leastUsedProxy);
          proxyUsage.set(leastUsedProxy, proxyUsage.get(leastUsedProxy) + 1);
          log(`Assigned proxy ${leastUsedProxy} to account ${account.username}`);
        } else {
          this.accountProxyMap.set(account.username, null);
          log(`Account ${account.username} will use direct connection (no proxy)`);
        }
      }
    }
  }

  getProxyForAccount(username) {
    if (!this.initialized) {
      log("Proxy manager not initialized, returning null", "WARN");
      return null;
    }

    const proxy = this.accountProxyMap.get(username);
    log(`Using ${proxy || "direct connection"} for account ${username}`);
    return proxy;
  }

  saveProxyMappings() {
    try {
      const mappingFile = path.join(__dirname, "proxy-mappings.json");
      const mappings = {};

      for (const [username, proxy] of this.accountProxyMap.entries()) {
        mappings[username] = proxy;
      }

      fs.writeFileSync(mappingFile, JSON.stringify(mappings, null, 2), "utf8");
      log(`Saved ${Object.keys(mappings).length} account-proxy mappings to ${mappingFile}`);
    } catch (error) {
      log(`Error saving proxy mappings: ${error.message}`, "ERROR");
    }
  }

  async loadProxyMappings() {
    try {
      const mappingFile = path.join(__dirname, "proxy-mappings.json");

      if (fs.existsSync(mappingFile)) {
        const data = fs.readFileSync(mappingFile, "utf8");
        const mappings = JSON.parse(data);

        const validProxies = new Set(this.proxies);

        for (const [username, proxy] of Object.entries(mappings)) {
          if (proxy === null || validProxies.has(proxy)) {
            this.accountProxyMap.set(username, proxy);
          }
        }

        log(`Loaded ${this.accountProxyMap.size} account-proxy mappings from ${mappingFile}`);
      } else {
        log(`No existing proxy mappings found, will create new mappings`);
      }
    } catch (error) {
      log(`Error loading proxy mappings: ${error.message}`, "WARN");
    }
  }
}

const proxyManager = new AccountProxyManager();

function getProxyAgent(proxy) {
  if (!proxy) return null;
  if (proxy.startsWith("http")) return new HttpsProxyAgent(proxy);
  throw new Error(`Unsupported proxy protocol: ${proxy}`);
}

async function refreshTokens(refreshToken, username) {
  return apiRateLimiter.schedule(async () => {
    try {
      log(`Refreshing access token via Stork API for ${username}...`);
      const response = await axios({
        method: "POST",
        url: `${config.stork.authURL}/refresh`,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": config.stork.userAgent,
          Origin: config.stork.origin,
        },
        data: { refresh_token: refreshToken },
        timeout: config.stork.requestTimeoutMs,
      });

      const tokens = {
        accessToken: response.data.access_token,
        idToken: response.data.id_token || "",
        refreshToken: response.data.refresh_token || refreshToken,
        expiresAt: Date.now() + 3600 * 1000,
        isAuthenticated: true,
        isVerifying: false,
      };

      log(`Token refreshed successfully via Stork API for ${username}`, "SUCCESS");
      return tokens;
    } catch (error) {
      log(`Token refresh failed for ${username}: ${error.message}`, "ERROR");
      throw error;
    }
  });
}

async function getSignedPrices(tokens, username) {
  return apiRateLimiter.schedule(async () => {
    try {
      const response = await axios({
        method: "GET",
        url: `${config.stork.baseURL}/stork_signed_prices`,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
          Origin: config.stork.origin,
          "User-Agent": config.stork.userAgent,
        },
        timeout: config.stork.requestTimeoutMs,
      });

      const dataObj = response.data.data;
      const result = Object.keys(dataObj).map((assetKey) => {
        const assetData = dataObj[assetKey];
        return {
          asset: assetKey,
          msg_hash: assetData.timestamped_signature.msg_hash,
          price: assetData.price,
          timestamp: new Date(assetData.timestamped_signature.timestamp / 1000000).toISOString(),
          ...assetData,
        };
      });

      return result;
    } catch (error) {
      log(`Error getting signed prices for ${username}: ${error.message}`, "ERROR");
      throw error;
    }
  });
}

async function sendValidation(tokens, msgHash, isValid, proxy, username) {
  return apiRateLimiter.schedule(async () => {
    try {
      const agent = getProxyAgent(proxy);
      const response = await axios({
        method: "POST",
        url: `${config.stork.baseURL}/stork_signed_prices/validations`,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
          Origin: config.stork.origin,
          "User-Agent": config.stork.userAgent,
        },
        httpsAgent: agent,
        data: { msg_hash: msgHash, valid: isValid },
        timeout: config.stork.requestTimeoutMs,
      });

      log(`✓ Validation successful for ${username} - ${msgHash.substring(0, 10)}... via ${proxy || "direct"}`);
      return response.data;
    } catch (error) {
      log(`✗ Validation failed for ${username} - ${msgHash.substring(0, 10)}...: ${error.message}`, "ERROR");
      throw error;
    }
  });
}

async function getUserStats(tokens, username) {
  return apiRateLimiter.schedule(async () => {
    try {
      const response = await axios({
        method: "GET",
        url: `${config.stork.baseURL}/me`,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
          Origin: config.stork.origin,
          "User-Agent": config.stork.userAgent,
        },
        timeout: config.stork.requestTimeoutMs,
      });

      return response.data.data;
    } catch (error) {
      log(`Error getting user stats for ${username}: ${error.message}`, "ERROR");
      throw error;
    }
  });
}

function validatePrice(priceData, username) {
  try {
    log(`Validating data for ${username} - ${priceData.asset || "unknown asset"}`);
    if (!priceData.msg_hash || !priceData.price || !priceData.timestamp) {
      log(`Incomplete data for ${username}, considered invalid`, "WARN");
      return false;
    }

    const currentTime = Date.now();
    const dataTime = new Date(priceData.timestamp).getTime();
    const timeDiffMinutes = (currentTime - dataTime) / (1000 * 60);

    if (timeDiffMinutes > 60) {
      log(`Data too old for ${username} (${Math.round(timeDiffMinutes)} minutes ago)`, "WARN");
      return false;
    }

    return true;
  } catch (error) {
    log(`Validation error for ${username}: ${error.message}`, "ERROR");
    return false;
  }
}

if (!isMainThread) {
  const { priceData, tokens, proxy, username } = workerData;

  async function validateAndSend() {
    try {
      const isValid = validatePrice(priceData, username);
      await sendValidation(tokens, priceData.msg_hash, isValid, proxy, username);
      parentPort.postMessage({ success: true, msgHash: priceData.msg_hash, isValid });
    } catch (error) {
      parentPort.postMessage({ success: false, error: error.message, msgHash: priceData.msg_hash });
    }
  }

  validateAndSend();
} else {
  const accountStats = new Map();

  async function runValidationProcess(tokenManager) {
    const username = tokenManager.username;
    try {
      log(`--------- STARTING VALIDATION PROCESS FOR ${username} ---------`);

      const tokens = {
        accessToken: tokenManager.accessToken,
        idToken: tokenManager.idToken,
        refreshToken: tokenManager.refreshToken,
      };

      let initialUserData;
      try {
        initialUserData = await retryWithExponentialBackoff(() => getUserStats(tokens, username), config.stork.maxRetries);
      } catch (error) {
        log(`Could not fetch initial user stats for ${username}: ${error.message}`, "ERROR");

        await tokenManager.refreshOrAuthenticate();
        initialUserData = await retryWithExponentialBackoff(() => getUserStats(tokens, username), config.stork.maxRetries);
      }

      if (!initialUserData || !initialUserData.stats) {
        throw new Error(`Could not fetch initial user stats for ${username}`);
      }

      const initialValidCount = initialUserData.stats.stork_signed_prices_valid_count || 0;
      const initialInvalidCount = initialUserData.stats.stork_signed_prices_invalid_count || 0;

      if (!accountStats.has(username)) {
        accountStats.set(username, {
          validCount: initialValidCount,
          invalidCount: initialInvalidCount,
          lastRunTime: Date.now(),
        });
      }

      const signedPrices = await retryWithExponentialBackoff(() => getSignedPrices(tokens, username), config.stork.maxRetries);

      const accountProxy = proxyManager.getProxyForAccount(username);

      if (!signedPrices || signedPrices.length === 0) {
        log(`No data to validate for ${username}`);
        try {
          const userData = await getUserStats(tokens, username);
          displayStats(userData, username);
        } catch (error) {
          log(`Could not fetch user stats for ${username}: ${error.message}`, "ERROR");
        }
        return;
      }

      const workerPromises = [];

      const chunkSize = Math.ceil(signedPrices.length / config.threads.maxWorkers);
      const batches = [];
      for (let i = 0; i < signedPrices.length; i += chunkSize) {
        batches.push(signedPrices.slice(i, i + chunkSize));
      }

      for (let i = 0; i < Math.min(batches.length, config.threads.maxWorkers); i++) {
        const batch = batches[i];

        const proxy = accountProxy;

        await randomDelay(100, 1000);

        batch.forEach((priceData) => {
          workerPromises.push(
            new Promise((resolve) => {
              const worker = new Worker(__filename, {
                workerData: { priceData, tokens, proxy, username },
              });
              worker.on("message", resolve);
              worker.on("error", (error) => resolve({ success: false, error: error.message }));
              worker.on("exit", () => resolve({ success: false, error: "Worker exited" }));
            })
          );
        });
      }

      const results = await Promise.all(workerPromises);
      const successCount = results.filter((r) => r.success).length;
      log(`Processed ${successCount}/${results.length} validations successfully for ${username}`, "SUCCESS");

      const updatedUserData = await retryWithExponentialBackoff(() => getUserStats(tokens, username), config.stork.maxRetries);

      const newValidCount = updatedUserData.stats.stork_signed_prices_valid_count || 0;
      const newInvalidCount = updatedUserData.stats.stork_signed_prices_invalid_count || 0;

      const stats = accountStats.get(username);
      const actualValidIncrease = newValidCount - stats.validCount;
      const actualInvalidIncrease = newInvalidCount - stats.invalidCount;

      accountStats.set(username, {
        validCount: newValidCount,
        invalidCount: newInvalidCount,
        lastRunTime: Date.now(),
      });

      displayStats(updatedUserData, username);
      log(`--------- VALIDATION SUMMARY FOR ${username} ---------`);
      log(`Total validations: ${newValidCount}`, "CUSTOM");
      log(`Successfully added: ${actualValidIncrease}`, "SUCCESS");
      log(`Failed validations: ${actualInvalidIncrease}`, "WARNING");
      log(`--------- COMPLETE FOR ${username} ---------`);

      return { success: true, username };
    } catch (error) {
      log(`Validation process stopped for ${username}: ${error.message}`, "ERROR");
      return { success: false, username, error: error.message };
    }
  }

  function displayStats(userData, username) {
    if (!userData || !userData.stats) {
      log(`No valid stats data available to display for ${username}`, "WARN");
      return;
    }

    log(`---------------------------------------------`);
    log(`User: ${userData.email || "N/A"} | ID: ${userData.id || "N/A"} | Referral Code: ${userData.referral_code || "N/A"}`);
    log(`✓ Valid Validations: ${userData.stats.stork_signed_prices_valid_count || 0}`, "SUCCESS");
    log(`✗ Invalid Validations: ${userData.stats.stork_signed_prices_invalid_count || 0}`, "WARN");
    log(`↻ Last Validated At: ${userData.stats.stork_signed_prices_last_verified_at || "Never"}`, "CUSTOM");
    log(`👥 Referral Usage Count: ${userData.stats.referral_usage_count || 0}`);
    log(`Next validation in ${config.stork.intervalSeconds} seconds...`);
    log(`---------------------------------------------`);
  }

  class AccountBatchManager {
    constructor() {
      this.currentBatch = [];
      this.activeAccounts = new Set();
      this.finished = false;
      this.batchIndex = 0;
      this.tokenManagers = new Map();
    }

    setupTokenManagers() {
      for (let i = 0; i < accounts.length; i++) {
        const tokenManager = new TokenManager(i);
        this.tokenManagers.set(accounts[i].username, tokenManager);
      }
      log(`Created ${this.tokenManagers.size} token managers for accounts`);
    }

    getNextBatch() {
      if (this.finished) return null;

      const startIndex = this.batchIndex * config.threads.accountBatchSize;
      if (startIndex >= accounts.length) {
        this.finished = true;
        return null;
      }

      const endIndex = Math.min(startIndex + config.threads.accountBatchSize, accounts.length);
      const batch = accounts.slice(startIndex, endIndex);
      this.batchIndex++;

      if (endIndex >= accounts.length) {
        this.finished = true;
      }

      return batch;
    }

    async processBatch() {
      const batch = this.getNextBatch();
      if (!batch) return null;

      log(`Processing batch ${this.batchIndex} with ${batch.length} accounts`);

      const promises = batch.map(async (account) => {
        const username = account.username;
        this.activeAccounts.add(username);

        await randomDelay(500, 3000);

        try {
          const tokenManager = this.tokenManagers.get(username);
          if (!tokenManager) {
            throw new Error(`No token manager found for ${username}`);
          }

          await tokenManager.getValidToken();

          const result = await runValidationProcess(tokenManager);

          setTimeout(() => {
            this.scheduleNextRun(username);
          }, config.stork.intervalSeconds * 1000);

          return result;
        } catch (error) {
          log(`Error processing account ${username}: ${error.message}`, "ERROR");

          setTimeout(() => {
            this.scheduleNextRun(username);
          }, config.stork.intervalSeconds * 2000);

          return { success: false, username, error: error.message };
        } finally {
          this.activeAccounts.delete(username);
        }
      });

      return Promise.all(promises);
    }

    scheduleNextRun(username) {
      if (this.activeAccounts.size < config.threads.maxConcurrentAccounts) {
        this.runForAccount(username);
      } else {
        setTimeout(() => {
          this.scheduleNextRun(username);
        }, 5000);
      }
    }

    async runForAccount(username) {
      this.activeAccounts.add(username);

      try {
        const tokenManager = this.tokenManagers.get(username);
        if (!tokenManager) {
          throw new Error(`No token manager found for ${username}`);
        }

        await tokenManager.getValidToken();
        await runValidationProcess(tokenManager);

        setTimeout(() => {
          this.scheduleNextRun(username);
        }, config.stork.intervalSeconds * 1000);
      } catch (error) {
        log(`Error in scheduled run for ${username}: ${error.message}`, "ERROR");

        setTimeout(() => {
          this.scheduleNextRun(username);
        }, config.stork.intervalSeconds * 2000);
      } finally {
        this.activeAccounts.delete(username);
      }
    }

    async start() {
      this.setupTokenManagers();

      await this.processBatch();

      this.scheduleNextBatch();
    }

    scheduleNextBatch() {
      if (this.finished) {
        log("All batches processed, continuous operation mode activated");
        return;
      }

      setTimeout(async () => {
        await this.processBatch();
        this.scheduleNextBatch();
      }, config.threads.accountBatchDelayMs);
    }
  }

  async function main() {
    log("\nTool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)\n", "WARN");
    if (!validateConfig()) {
      process.exit(1);
    }
    fs.writeFileSync("proxy-mappings.json", "{}", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    log(`Starting Stork Oracle Bot with ${accounts.length} accounts`);
    log(`Max concurrent accounts: ${config.threads.maxConcurrentAccounts}`);
    log(`Account batch size: ${config.threads.accountBatchSize}`);
    log(`Account batch delay: ${config.threads.accountBatchDelayMs}ms`);

    await proxyManager.initialize();

    const batchManager = new AccountBatchManager();
    await batchManager.start();

    setInterval(() => {
      log(`Active accounts: ${batchManager.activeAccounts.size}`);
      log(`Total processed: ${accountStats.size}`);
    }, 60 * 1000);

    process.on("SIGINT", () => {
      log("Received SIGINT, gracefully shutting down...", "WARN");
      setTimeout(() => {
        process.exit(0);
      }, 2000);
    });
  }
  main();
}
