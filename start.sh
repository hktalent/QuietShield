#!/bin/bash
# 生成自签名证书（只需要执行一次）
openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt -days 365 -nodes -subj "/CN=localhost"
# 启动 https 静态文件服务 0.0.0.0:8088
/Users/51pwn/anaconda3/bin/python3 -c "
from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl

addr = ('0.0.0.0', 8088)
httpd = HTTPServer(addr, SimpleHTTPRequestHandler)
httpd.socket = ssl.wrap_socket(
    httpd.socket,
    certfile='server.crt',
    keyfile='server.key',
    server_side=True
)
print('HTTPS server running on https://0.0.0.0:8088')
httpd.serve_forever()
"


