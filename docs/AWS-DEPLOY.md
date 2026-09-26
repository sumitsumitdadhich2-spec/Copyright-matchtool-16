# CMT — AWS EC2 par deploy (Hinglish guide)

Target: **1 EC2 instance** (16 vCPU / 16 GB RAM / 100 GB EBS, Ubuntu 24.04) + **1 S3 bucket** (private).
App Docker me chalta hai, Caddy automatic HTTPS deta hai, ffmpeg har core par ek engine chalata hai.

---

## 1. S3 bucket banao

1. AWS Console → **S3 → Create bucket**
   - Name: `cmt-storage-<kuch-unique>` (globally unique hona chahiye)
   - Region: wahi jahan EC2 launch karoge (e.g. `ap-south-1` Mumbai)
   - **Block all public access: ON** (bucket private rahega)
   - Versioning: off (zaroorat nahi)
2. **Lifecycle rule** (optional, disk-cost bachane ke liye):
   Bucket → Management → Create lifecycle rule
   - Name: `expire-old-media`
   - Prefix: `media/`
   - Action: *Expire current versions* after **30 days**
   - Dusra rule: *Abort incomplete multipart uploads* after **1 day** (poore bucket par)

Bucket layout jo app khud banata hai:

```
auth/users.json            users (admin shiva hardcoded, baaki yahan)
auth/user-keys.json        per-user Gemini / TwelveLabs keys
auth/tokens.json           API tokens
scans/<id>.json            scan record backup (source of truth = EBS)
media/<id>/short.mp4       original videos backup
media/<id>/movie.mp4
embeddings/<id>/...        TwelveLabs embeddings
```

## 2. IAM role (EC2 → S3, bina access keys)

1. **IAM → Policies → Create policy** → JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::cmt-storage-XXXX"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::cmt-storage-XXXX/*"
    }
  ]
}
```

   Name: `cmt-s3-access`
2. **IAM → Roles → Create role** → Trusted entity: *AWS service → EC2* → policy `cmt-s3-access` attach → Name: `cmt-ec2-role`.

Code me kahin bhi AWS access key nahi hai — SDK role se credentials automatically le leta hai.

## 3. EC2 launch

1. **EC2 → Launch instance**
   - Name: `cmt`
   - AMI: **Ubuntu Server 24.04 LTS** (64-bit x86)
   - Instance type: **c6i.4xlarge** ya **c7i.4xlarge** (16 vCPU / 32 GB) — ya **c6a.4xlarge**.
     16 GB wale ke liye `m6i.2xlarge` 8 vCPU hai; 16 vCPU + 16 GB exact combination compute-family me nahi milta,
     isliye 16 vCPU chahiye to c-family lo (RAM zyada mil jayegi, koi dikkat nahi).
   - Key pair: naya banao, `.pem` download karo
   - **Network / Security group** — inbound:
     | Type  | Port | Source      |
     |-------|------|-------------|
     | SSH   | 22   | My IP       |
     | HTTP  | 80   | 0.0.0.0/0   |
     | HTTPS | 443  | 0.0.0.0/0   |
   - **Storage**: root 20 GB gp3 + **ek extra EBS volume 100 GB gp3** (`/dev/sdf`)
   - **Advanced → IAM instance profile**: `cmt-ec2-role`
2. Launch → **Elastic IP** allocate karke instance se associate karo (IP fixed rahe).

## 4. Server setup (SSH)

```bash
ssh -i cmt.pem ubuntu@<ELASTIC-IP>

# Docker install
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker

# 100 GB EBS volume format + /data par mount
lsblk                              # extra disk dekho (e.g. nvme1n1)
sudo mkfs.ext4 -L cmtdata /dev/nvme1n1
sudo mkdir -p /data
echo 'LABEL=cmtdata /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo chown -R 1001:1001 /data     # container me app user uid 1001 hai
df -h /data
```

## 5. App deploy

```bash
cd ~
git clone https://github.com/<org>/<repo>.git cmt
cd cmt

cp .env.example .env
nano .env
```

`.env` me kam se kam ye set karo:

```
AWS_REGION=ap-south-1
S3_BUCKET=cmt-storage-XXXX
SESSION_SECRET=<openssl rand -base64 48 ka output>
SITE_ADDRESS=:80            # DNS ready hone par domain daalo (step 6)
```

Phir:

```bash
docker compose up -d --build
docker compose logs -f app
```

Logs me ye dikhna chahiye:

```
[ffmpeg-pool] detected 16 cores → 16 engines
[work-dir] RAM work dir: /dev/shm/cmt (budget 6144 MB), disk fallback: /data/work
[scan-store] restored N scans from S3
```

Browser me `http://<ELASTIC-IP>` kholo → login `shiva` (same password jo pehle tha).

Health check: `curl http://<ELASTIC-IP>/api/health`

## 6. Domain + HTTPS

1. DNS provider me **A record**: `cmt.yourdomain.com → <ELASTIC-IP>`
2. `.env` me `SITE_ADDRESS=cmt.yourdomain.com`
3. `docker compose up -d` (caddy restart hoga, Let's Encrypt cert khud le lega — 1-2 min)
4. `https://cmt.yourdomain.com` kholo.

## 7. Update kaise kare

```bash
cd ~/cmt
git pull
docker compose up -d --build     # sirf app rebuild hota hai, data safe hai
docker compose logs -f app
```

Rollback: `git checkout <purana-commit>` → `docker compose up -d --build`.

## 8. Rozmarra ke commands

| Kaam | Command |
|------|---------|
| Status | `docker compose ps` |
| Live logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| ffmpeg processes dekhna | `htop` (16 ffmpeg dikhne chahiye chunking/render me) |
| Disk | `df -h /data` |
| RAM work dir | `df -h /dev/shm` |
| Container me shell | `docker compose exec app sh` |

## 9. Backup / restore

- **Scan records, users, keys, tokens**: EBS (`/data`) + S3 dono jagah.
  Container restart / rebuild par sab wapas aa jata hai.
- **Naya instance** (EBS gaya): bas `.env` same rakho aur `docker compose up -d` —
  boot par app S3 se scan JSON restore karta hai; original videos S3 se tab download
  hote hain jab pehli baar zaroorat pade (render / merge / rescan).
- EBS snapshot lena ho: EC2 → Volumes → `cmtdata` → Create snapshot.

## 10. Troubleshooting

| Problem | Fix |
|---------|-----|
| `S3: AccessDenied` | IAM role instance se attached hai? Policy me sahi bucket ARN? |
| `SESSION_SECRET is required` | `.env` me secret daalo, `docker compose up -d` |
| Upload slow | Browser ek hi continuous stream bhejta hai (koi chunking nahi) — card me live Mbps dikhta hai, wahi aapke internet ka real upload speed hai. Security group / Caddy check karo: `docker compose logs caddy`. |
| `Request body exceeded 10MB` log me | Upload route `proxy.ts` matcher se bahar hona chahiye (default hai). Agar matcher badla hai to `/api/scans/<id>/upload` ko exclude rakho, warna Next.js body RAM me buffer karke 10 MB par kaat deta hai. |
| Upload beech me ruka / 408 | Connection tootne par browser server ke confirmed byte se khud resume karta hai. Dockerfile ka `--require ./server-timeouts.cjs` Node ka 5-minute body timeout hatata hai — `docker compose up -d --build` ke baad `docker compose top app` me `node --require ./server-timeouts.cjs server.js` dikhna chahiye. |
| `/dev/shm` full | `WORK_RAM_BUDGET_MB` kam karo ya `shm_size` badhao (compose me) |
| Sirf 1 ffmpeg process | `.env` me `FFMPEG_ENGINES=auto` hai? `/api/health` me `engines` dekho |
| Cert nahi mila | Port 80 + 443 open hain? DNS A record sahi IP par? `docker compose logs caddy` |
