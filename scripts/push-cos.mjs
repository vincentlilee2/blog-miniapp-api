// 上传小程序数据包到腾讯云 COS（备用发布通道；默认路径走本仓 data/）
// 用法:
//   COS_SECRET_ID=xxx COS_SECRET_KEY=xxx COS_BUCKET=blog-miniapp-125xxxx \
//   COS_REGION=ap-shanghai node scripts/push-cos.mjs [data.json 路径]
// 依赖 cos-nodejs-sdk-v5（devDependency，仅本机发布用，不入云托管镜像）
// 也可用 coscmd（腾讯云官方 CLI）替代: coscmd upload data/data.json /miniapp/data.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, '..', 'data', 'data.json');

if (!fs.existsSync(file)) {
  console.error(`数据包不存在: ${file}（先跑 export-miniapp.mjs）`);
  process.exit(1);
}

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, COS_KEY } = process.env;
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET) {
  console.error('缺少 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET 环境变量');
  process.exit(1);
}

const key = COS_KEY || 'miniapp/data.json';

try {
  const COS = (await import('cos-nodejs-sdk-v5')).default;
  const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

  const { statusCode, error } = await new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION || 'ap-shanghai',
        Key: key,
        Body: fs.createReadStream(file),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache',
      },
      (err, data) => (err ? reject(err) : resolve(data)),
    );
  });

  if (statusCode >= 200 && statusCode < 300) {
    console.log(`[push-cos] ✅ ${file} → cos://${COS_BUCKET}/${key} (${statusCode})`);
  } else {
    console.error(`[push-cos] 上传失败 HTTP ${statusCode}`, error);
    process.exit(1);
  }
} catch (e) {
  // 常见: SDK 未安装 → 提示改用 coscmd
  console.error(`[push-cos] ❌ ${e.message}`);
  console.error('提示: 未安装 SDK 可用腾讯云官方 CLI 代替:  coscmd upload <file> /miniapp/data.json');
  process.exit(1);
}
