# 微信云托管部署镜像（Blog 小程序 API）
# 构建环境在国内，npm 走镜像加速
FROM node:20-alpine

WORKDIR /app

# npm 国内镜像
RUN npm config set registry https://registry.npmmirror.com

# 先拷依赖清单，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 业务代码（.dockerignore 排除了 node_modules 等）
COPY . .

# 云托管注入 PORT（默认 80）；本地不起容器时默认 3004
ENV PORT=80
EXPOSE 80

CMD ["node", "server.js"]
