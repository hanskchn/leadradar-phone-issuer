# 手机签发器

- 正式签发器：https://hanskchn.github.io/leadradar-phone-issuer/
- 自检页：https://hanskchn.github.io/leadradar-phone-issuer/selfcheck.html

本仓库只存放 iPhone 上使用的静态页面代码与一把**一次性测试钥匙**，**不含任何真实私钥、钥匙包或客户数据**。

- `test-phone-keys.json` 是测试用的一次性 RSA 钥匙，口令 `selfcheck-2026`，与真实授权无关。
- 真钥匙包只在卖家手机上以口令加密的密文形式存在，不会进入本仓库或任何公开地址。
- 页面不发起业务网络请求；签名在手机浏览器内完成，断网也能用。

源码由私有仓库同步发布；请不要直接在本仓库提改动。