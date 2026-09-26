# CMT — Termux (Android tablet) se AWS EC2 par deploy — A to Z (beginner)

Ye guide maan kar chalti hai ki tumhare paas **sirf ek Android tablet + Termux** hai, laptop nahi.
Tablet se hum AWS console (browser me) use karenge aur Termux se SSH karke server set karenge.

Repo: `https://github.com/sumitsumitdadhich2-spec/Copyright-matchtool-by-gamini-3`

---

## PART A — Termux taiyaar karo (tablet par)

### A1. Termux install
- **Play Store wala Termux mat lo** (purana hai, toot jata hai).
- F-Droid se lo: browser me `https://f-droid.org/packages/com.termux/` kholo → APK download → install.
  (Ya GitHub releases: `https://github.com/termux/termux-app/releases`)

### A2. Termux me basic packages
Termux kholo aur ek-ek line paste karo (Enter dabao, `Y` poochhe to `y` likho):

```bash
pkg update -y && pkg upgrade -y
pkg install -y openssh git nano curl termux-tools
termux-setup-storage
```

`termux-setup-storage` par Android permission popup aayega → **Allow** karo. Isse Termux tumhare Download folder ko padh sakta hai (`~/storage/downloads`).

### A3. Copy-paste kaise karein Termux me
- Paste: screen par **long-press → Paste**, ya `Ctrl + Alt + V`
- Copy: text select karke **Copy**
- `Ctrl` key: Termux keyboard ke upar wali extra row me `CTRL` button hota hai
- Command band karni ho: `CTRL + C`
- Nano editor save: `CTRL + O` → Enter → exit: `CTRL + X`

---

## PART B — AWS console me setup (tablet ke browser me)

Chrome me `https://console.aws.amazon.com` kholo. Tablet par **"Desktop site"** on kar lo (Chrome menu → Desktop site) — console mobile me bekaar dikhta hai.

Region upar-right se **Asia Pacific (Mumbai) ap-south-1** select karo. Sab kuch isi region me banana hai.

### B1. S3 bucket
1. Search bar me `S3` → **Create bucket**
2. Bucket name: `cmt-storage-<tumhara-naam>-<random-number>` (e.g. `cmt-storage-sumit-4821`) — poori duniya me unique hona chahiye
3. Region: `ap-south-1`
4. **Block all public access: ON** (tick raha rahe)
5. Baaki default → **Create bucket**
6. Bucket name **kahin note kar lo** — `.env` me chahiye hoga

### B2. IAM policy + role (EC2 ko S3 ka access, bina password)
1. Search `IAM` → left me **Policies → Create policy** → **JSON** tab → ye paste karo (apna bucket name daalo, 2 jagah):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::cmt-storage-sumit-4821"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::cmt-storage-sumit-4821/*"
    }
  ]
}
```

   Next → Name: `cmt-s3-access` → **Create policy**
2. Left me **Roles → Create role**
   - Trusted entity: **AWS service** → Use case: **EC2** → Next
   - Permissions me search `cmt-s3-access` → tick → Next
   - Role name: `cmt-ec2-role` → **Create role**

### B3. Key pair (SSH ka password-file)
1. Search `EC2` → left me **Network & Security → Key Pairs → Create key pair**
2. Name: `cmt-key` · Type: **RSA** · Format: **.pem** → Create
3. `cmt-key.pem` file **Download** folder me aa jayegi. Ye file kabhi kisi ko mat dena.

### B4. EC2 instance launch
1. EC2 → **Launch instance**
2. Name: `cmt`
3. AMI: **Ubuntu Server 24.04 LTS (HVM), 64-bit (x86)** — Free tier eligible wala nahi, ye wala
4. Instance type: **c6i.4xlarge** (16 vCPU / 32 GB) — 16 vCPU ke liye ye lo.
   (Sasta test karna ho pehle: `t3.xlarge` 4 vCPU — kaam karega, bas slow)
5. Key pair: `cmt-key` select karo
6. **Network settings → Edit**:
   - Auto-assign public IP: **Enable**
   - Security group: **Create new** → name `cmt-sg`
   - Inbound rules — 3 rules banao (**Add security group rule**):

     | Type  | Port | Source type |
     |-------|------|-------------|
     | SSH   | 22   | Anywhere (0.0.0.0/0) — tablet ka IP badalta rehta hai |
     | HTTP  | 80   | Anywhere    |
     | HTTPS | 443  | Anywhere    |

7. **Configure storage**:
   - Root: `20` GiB gp3
   - **Add new volume** → `100` GiB, gp3, Device `/dev/sdf`
8. **Advanced details** → scroll → **IAM instance profile**: `cmt-ec2-role`
9. **Launch instance**

### B5. Elastic IP (fixed IP, warna restart par IP badal jata hai)
1. EC2 → left **Network & Security → Elastic IPs → Allocate** → Allocate
2. Us IP ko select → **Actions → Associate** → Instance: `cmt` → Associate
3. Ye IP note karo → aage `<IP>` likha hai wahan yehi daalna hai. Example: `13.234.56.78`

---

## PART C — Termux se server me ghusna (SSH)

### C1. key file Termux me lao

```bash
mkdir -p ~/.ssh
cp ~/storage/downloads/cmt-key.pem ~/.ssh/cmt-key.pem
chmod 600 ~/.ssh/cmt-key.pem
```

Agar `No such file` aaye → file ka naam check karo: `ls ~/storage/downloads | grep pem`

### C2. connect

```bash
ssh -i ~/.ssh/cmt-key.pem ubuntu@<IP>
```

Pehli baar `Are you sure you want to continue connecting (yes/no)?` → `yes` likho.
Prompt `ubuntu@ip-172-...:~$` dikhe → tum server ke andar ho.

**Shortcut** taaki har baar lamba command na likhna pade — Termux me (server se `exit` karke) ye ek baar chalao:

```bash
cat >> ~/.ssh/config <<'EOF'
Host cmt
    HostName <IP>
    User ubuntu
    IdentityFile ~/.ssh/cmt-key.pem
    ServerAliveInterval 60
EOF
```

Ab bas `ssh cmt` likhne se connect ho jaoge.

> Tablet ki screen off hone par SSH cut ho sakta hai. Lambe kaam (`docker compose up --build`) ke liye Part D me `tmux` use kar rahe hain — cut ho bhi jaye to kaam chalta rahega.

---

## PART D — Server setup (ye sab commands SERVER ke andar, `ssh cmt` ke baad)

### D1. Docker + tools

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git tmux htop
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

`exit` zaroori hai (docker group apply karne ke liye). Phir dobara: `ssh cmt`

Check: `docker --version` aur `docker compose version` dono print hon.

### D2. 100 GB disk ko /data par mount

```bash
lsblk
```

Output me jo disk **100G** ka hai aur jiska koi MOUNTPOINT nahi hai — uska naam dekho (zyadatar `nvme1n1`). Fir:

```bash
sudo mkfs.ext4 -L cmtdata /dev/nvme1n1
sudo mkdir -p /data
echo 'LABEL=cmtdata /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo chown -R 1001:1001 /data
df -h /data
```

`df -h /data` me ~98G Avail dikhe → sahi hai.

### D3. GitHub se code lao

Repo **private** hai to GitHub token chahiye:
1. Tablet browser me `https://github.com/settings/tokens` → **Generate new token (classic)**
2. Note: `cmt-ec2` · Expiration: 90 days · Scope: sirf **repo** tick → Generate
3. Token (`ghp_...`) copy karo — ek baar hi dikhega

Server par:

```bash
cd ~
git clone https://github.com/sumitsumitdadhich2-spec/Copyright-matchtool-by-gamini-3.git cmt
```

Username poochhe → `sumitsumitdadhich2-spec` · Password poochhe → **token paste** karo (GitHub password nahi chalta).

Baar-baar na poochhe iske liye:

```bash
cd ~/cmt
git config credential.helper store
git pull      # ek baar aur username/token dega, phir yaad rakhega
```

### D4. .env banao

```bash
cd ~/cmt
cp .env.example .env
openssl rand -base64 48
```

Jo lambi random string print hui, copy kar lo. Ab:

```bash
nano .env
```

Ye 3 lines badlo (arrow keys se jao, purana hatao, naya likho):

```
S3_BUCKET=cmt-storage-sumit-4821        <- apna bucket name
SESSION_SECRET=<yahan random string paste>
SITE_ADDRESS=:80                        <- abhi aise hi rehne do
```

`AWS_REGION=ap-south-1` already sahi hai. Save: `CTRL+O` → Enter → `CTRL+X`.

### D5. Build + start (tmux ke andar, taaki tablet lock hone par bhi chale)

```bash
tmux new -s cmt
cd ~/cmt
docker compose up -d --build
```

Pehli build 5–10 minute legi (ffmpeg download + Next.js build). Agar Termux disconnect ho jaye:
`ssh cmt` → `tmux attach -t cmt` → wahi screen wapas.

Build ke baad:

```bash
docker compose ps
docker compose logs -f app
```

Logs me ye dikhna chahiye:

```
[ffmpeg-pool] detected 16 cores → 16 engines
[work-dir] RAM work dir: /dev/shm/cmt (budget 6144 MB), disk fallback: /data/work
```

Logs se bahar: `CTRL+C`. tmux se bahar (bina band kiye): `CTRL+B` phir `D`.

### D6. Test

Tablet browser me `http://<IP>` kholo → login page → `shiva` se login.
Ya server par: `curl http://localhost/api/health` → `{"status":"ok"...}` ya `degraded` (S3 issue — Part F dekho).

---

## PART E — Domain + HTTPS (optional par recommended)

Bina domain HTTP par chalega, par HTTPS ke liye domain chahiye.

1. Apne domain provider (GoDaddy/Hostinger/Cloudflare) me **A record**: `cmt` → `<IP>` (Cloudflare ho to proxy **off / DNS only**)
2. Server par:

```bash
cd ~/cmt
nano .env        # SITE_ADDRESS=cmt.tumharadomain.com
docker compose up -d
docker compose logs -f caddy
```

1–2 min me `certificate obtained successfully` → `https://cmt.tumharadomain.com` chal jayega.

---

## PART F — Rozmarra ke kaam

| Kaam | Command (server par, `cd ~/cmt` ke baad) |
|------|------|
| Connect | Termux: `ssh cmt` |
| Naya code deploy (v0 se main me merge ke baad) | `git pull && docker compose up -d --build` |
| Status | `docker compose ps` |
| Live logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Poora band | `docker compose down` (data safe rehta hai) |
| ffmpeg processes dekhna | `htop` (render/chunking me 16 ffmpeg dikhne chahiye; `q` se bahar) |
| Disk | `df -h /data` |
| RAM work area | `df -h /dev/shm` |
| Purani docker images saaf | `docker image prune -f` |
| Server band (paise bachao) | AWS console → Instance → **Stop** (Elastic IP + data rehta hai). Wapas **Start** → app khud chalu (`restart: always`) |

## PART G — Common problems

| Dikkat | Kya karein |
|--------|-----------|
| `ssh: Permission denied (publickey)` | `chmod 600 ~/.ssh/cmt-key.pem` kiya? User `ubuntu` hai? Sahi IP? |
| `ssh: Connection timed out` | Security group me port 22 Anywhere hai? Instance Running hai? |
| `permission denied ... docker.sock` | `exit` karke dobara `ssh cmt` (group apply) |
| `git clone` me `Authentication failed` | Password ki jagah **token** daalo, GitHub password nahi |
| Health `degraded` / logs me `AccessDenied` | IAM role instance se attached hai? Policy me bucket name exact match? Region `.env` me sahi? |
| `SESSION_SECRET is required` | `.env` me secret daalo → `docker compose up -d` |
| `[ffmpeg-pool] detected 4 cores` (16 nahi) | Instance type chhota hai — console me Stop → Actions → Instance settings → Change instance type → `c6i.4xlarge` → Start |
| Website nahi khul rahi | Security group 80/443 Anywhere? `docker compose ps` me dono `running`? `docker compose logs caddy` |
| Termux session cut, build adhoori | `ssh cmt` → `tmux attach -t cmt` |
| Disk full | `df -h /data`; app khud purane scans hata deta hai (MAX_SCANS=10). Bada karna ho: EBS volume Modify → phir `sudo resize2fs /dev/nvme1n1` |

## PART H — Kharcha (approx, Mumbai)

- c6i.4xlarge: ~$0.77/hr (~₹65/hr) → **24×7 = ~₹47,000/mahina**. Use na ho to **Stop** kar do — stopped instance ka sirf disk charge (~₹1,000/mahina 120 GB).
- t3.xlarge (test ke liye): ~$0.18/hr (~₹15/hr).
- S3: ~₹2/GB/mahina.
- Elastic IP: instance Running ho to free; Stopped ho to ~₹350/mahina.
