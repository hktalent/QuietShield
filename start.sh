#!/bin/bash
# 生成自签名证书（只需要执行一次）
if [ ! -f "server.key" ] || [ ! -f "server.crt" ]; then
  openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt -days 365 -nodes -subj "/CN=localhost"
fi
# 启动 https 静态文件服务 0.0.0.0:8088
/Users/51pwn/anaconda3/bin/python3 Server.py
