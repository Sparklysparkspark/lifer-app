---
title: GPU acceleration
description: How Lifer uses a graphics card to speed up species matching, and how to give a Docker or TrueNAS server access to one.
---

# GPU acceleration

Lifer can use a graphics card (GPU) to match species faster. It's automatic: there's nothing to turn on, and no setting to choose. On a server you only need to give the container access to the GPU.

## How it works {#how-it-works}

Once the [species-matching model](../settings.md#species-model) is downloaded, Lifer runs a one-time hardware test when it starts:

1. It looks for every GPU it can use.
2. It checks that each one gives the same answers as the CPU. A GPU that doesn't is never used.
3. It times them, and moves species matching to the fastest GPU if it's at least 15% faster than the CPU. Otherwise matching stays on the CPU.

Lifer remembers the result. It only tests again if the hardware, the graphics driver or the matching models change, or if you ask it to.

The speed-up can be large: even an older graphics card can match species several times faster than the CPU.

If anything goes wrong with a GPU, Lifer uses the CPU instead. Suggestions are the same either way, just slower.

## What's supported {#supported}

| Where Lifer runs | GPUs | What you need to do |
|---|---|---|
| Desktop app on a Mac | The Mac's built-in GPU | Nothing. |
| Desktop app on Windows | Any GPU with a current driver | Nothing. |
| Docker or TrueNAS on Linux | NVIDIA | Pass the GPU into the container. See [Docker](#docker) or [TrueNAS](#truenas). |
| Docker or TrueNAS on Linux | Intel and AMD | Pass the GPU into the container. See [Docker](#docker) or [TrueNAS](#truenas). |

Intel and AMD GPUs on Linux are detected and tested automatically, but they haven't been tried on many machines yet. If you have one, we'd love to hear how it goes: [open an issue on GitHub](https://github.com/Sparklysparkspark/lifer-app/issues).

### The desktop app connected to a server {#desktop-and-server}

When the desktop app is connected to a server, it can match photos on your computer or leave it to the server. It times both and uses whichever is faster, checking the other again every 20 photos or so. A server with a GPU often beats a laptop; a fast laptop beats a server without one. The import screen shows "Matching on this computer or the server, whichever is faster".

## One-time downloads for NVIDIA {#nvidia-downloads}

The Lifer image doesn't include NVIDIA's software, so it stays small for everyone else. When Lifer finds an NVIDIA GPU, it downloads what it needs once, into its app data folder (`/app-data` in Docker):

- NVIDIA's CUDA libraries, matched to your driver, about 1.5 GB.
- A full-precision copy of the species identification model, about 1.2 GB.

That's about 2.7 GB in total. Until it finishes, matching runs on the CPU as usual. Mac, Windows, Intel and AMD don't need any extra downloads.

## Give a Docker container the GPU {#docker}

The shipped [`docker-compose.yml`](https://raw.githubusercontent.com/Sparklysparkspark/lifer-app/main/docker-compose.yml) has the lines below in the `api` service, commented out. Uncomment the ones for your GPU, then run `docker compose up -d`.

### NVIDIA

On the server, install the NVIDIA driver (version 525 or newer) and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). Check that the driver works by running `nvidia-smi` on the server. Then add this under `api:`:

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

With plain `docker run`, add `--gpus all` instead.

### Intel and AMD

Pass in `/dev/dri`, and add the server's `render` group so Lifer's user can open the GPU. Find the group's number on the server:

```bash
stat -c %g /dev/dri/renderD128
```

Then add this under `api:`, with your number in place of `107`:

```yaml
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "107"
```

## Give the TrueNAS app the GPU {#truenas}

1. **NVIDIA only:** open **Apps > Configuration > Settings**, tick **Install NVIDIA Drivers**, and save.
2. Open **Apps > Lifer > Edit**.
3. Under **Resources Configuration > GPU Configuration**, select your NVIDIA GPU, or tick **Passthrough available (non-NVIDIA) GPUs** for Intel or AMD.
4. Save. TrueNAS restarts Lifer with the GPU.

If you run Lifer as a TrueNAS Custom App from `docker-compose.yml`, follow the [Docker](#docker) steps instead.

## Check where matching runs {#check}

**Settings > Offline data > Species-matching model** shows whether species matching runs on the CPU or a GPU, and which one.

Click **Re-test hardware** to run the test again, for example after you add a GPU, pass one into the container, or update the graphics driver.

## Turn it off {#turn-off}

You shouldn't need to. For troubleshooting, set the `LIFER_GPU` environment variable to `off` and restart Lifer. Matching then always runs on the CPU. With Docker, set `LIFER_GPU=off` in `.env` and run `docker compose up -d`. On TrueNAS, add it under **Lifer Configuration > Additional Environment Variables**.

## Troubleshooting {#troubleshooting}

Whatever happens with the GPU, Lifer keeps working on the CPU, so these only cost speed.

- **Matching stays on the CPU on a server with a GPU.** The GPU probably isn't passed into the container. Follow [Docker](#docker) or [TrueNAS](#truenas), then click **Re-test hardware**. For NVIDIA, `docker compose exec api nvidia-smi` should list your card.
- **NVIDIA driver too old.** Lifer needs NVIDIA driver 525 or newer. `nvidia-smi` on the server shows the version. Update the driver, restart Lifer, and click **Re-test hardware**.
- **Intel or AMD GPU isn't used.** Check that `/dev/dri` is passed in and the `render` group number is right. Some older or very new GPUs may not work yet. Please [let us know](https://github.com/Sparklysparkspark/lifer-app/issues) which GPU you have.
- **A GPU is found but not used.** Either it gave slightly different answers than the CPU, or it wasn't at least 15% faster. That's on purpose: Lifer only uses a GPU when it's both correct and clearly faster.
- **The NVIDIA download failed.** Lifer keeps matching on the CPU. Check the server can reach the internet and has about 3 GB free for app data, then click **Re-test hardware**.
