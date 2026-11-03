# BP Journal

A small, self-hosted blood-pressure photo journal. Select a JPEG of your monitor and it uploads immediately. The server reads SYS, DIA and PUL locally and appends the reading to one CSV file. The minimal Mantine interface shows a chart of all three metrics, with the full history available as a CSV download.

There are no cloud OCR services, API keys, external fonts or runtime model downloads. The included English OCR model and image-processing libraries run on your server. The web app is protected by one shared password per installation.

## Run with Docker

```sh
cp .env.example .env
# Edit .env: choose APP_PASSWORD.
docker compose up --build -d
```

Open <http://localhost:3000> and sign in with `APP_PASSWORD`. `APP_URL` must exactly match the address in your browser. The supplied Compose file binds the port to this machine only; use Tailscale Serve or an HTTPS reverse proxy for remote access.

Passwords have no minimum length, but a non-empty password is required. Each successful sign-in starts a one-year (365-day) session. Signing in again resets its expiry for another year.

The CSV is stored at `/app/data/readings.csv` in the persistent `readings` volume. Back it up; container replacement preserves it, but deleting the volume removes your readings. The app supports one server process writing this file.

## Run with Node

Use Node 22.18 or newer (Node 24 LTS is used in the container).

```sh
cp .env.example .env
# Edit .env: choose APP_PASSWORD and the browser address in APP_URL.
npm ci
npm run build
npm start
```

The Node setup stores readings in `./data/readings.csv` by default. Set `DATA_FILE` to use another location. Credentials, readings, photos and generated files should stay outside Git. There is no default installation password.

For development, set `APP_URL=http://localhost:5173`, then run `npm run dev` and `npm run dev:web` in separate terminals. The Vite page proxies API requests to the Node server on port 3000.

## Use it from an iPhone

1. Select Left or Right if you want to record the arm. Tap the selected button again to clear it; neither selected means `unknown`.
2. Choose a clear JPEG photo with all three values and their SYS/DIA/PUL labels visible. Choosing it starts the upload automatically.
3. Keep the page open until the upload is acknowledged. After that you can close the page; recognition and saving continue on the server.

The browser reads the original photo's EXIF capture time, then resizes the image to at most 1600 pixels on its longest edge and encodes it as JPEG at 85% quality. The full-size photo is not uploaded. HEIC is not supported; export or share a JPEG first if your iPhone supplies a HEIC file.

If the image includes a timezone offset, it is preserved as an instant. If EXIF contains a date without a timezone, the browser's local timezone is used. If capture metadata is absent or unreadable, the server uses the upload time. The CSV stores ISO timestamps; the page displays them in the viewer's local time.

Photos are held temporarily in server memory and discarded after recognition, including failed recognition. Only successful readings enter the CSV. Processing jobs and errors are kept in memory: closing the browser is safe after acknowledgement, but restarting or stopping the server interrupts unfinished uploads. Recent processing errors are visible when you reopen the page while the same server is running.

The reader targets upright, three-row seven-segment displays with the SYS/DIA/PUL labels on the right, as on the UA-611Plus. It checks the displayed segments and fails when it cannot identify every value. Blurred, cropped, tilted or reflective displays and monitor error codes can be rejected. It does not invent missing digits or interpret the measurements medically.

## Tailscale and public hosting

With Tailscale installed on your server, [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) can proxy this loopback-only app to your tailnet over HTTPS:

```sh
tailscale serve --bg 3000
```

Set `APP_URL` in `.env` to the exact HTTPS URL reported by Serve, then recreate the app (`docker compose up -d`). Keep the shared password enabled.

For a dedicated `bp-journal` hostname without changing your server's Tailscale name, use the optional Tailscale container with Docker Compose 2.17 or newer:

```sh
docker compose -f compose.yaml -f compose.tailscale.yaml up -d
docker compose -f compose.yaml -f compose.tailscale.yaml logs --follow tailscale
```

When the sign-in link appears, open it and authorize the new device in your own tailnet. Press Ctrl+C to stop following the logs; the container keeps running. Initial sign-in has a ten-minute timeout. If the container restarts before you finish, use the newest link from its logs. Then enable private HTTPS:

```sh
docker compose -f compose.yaml -f compose.tailscale.yaml exec tailscale tailscale serve --bg 3000
```

Set `APP_URL` to the exact address Serve reports, normally `https://bp-journal.<your-tailnet>.ts.net`, and run the two-file `up -d` command again. Use both Compose files for subsequent starts, updates and restarts so the app and its Tailscale container stay connected.

The Tailscale container uses userspace networking without extra network capabilities or a TUN device. Its identity and HTTPS configuration persist in the `tailscale-state` volume; retain that volume to avoid authorizing a new device after recreation. The separate `readings` volume holds your CSV. This setup uses Tailscale Serve, keeping the app private to your tailnet.

For internet access, put the app behind an HTTPS reverse proxy and set `APP_URL` to its public origin, such as `https://bp.example.com`. Login cookies become Secure automatically when `APP_URL` uses HTTPS. Do not publish the development server. Requests from a different browser origin are rejected. `HOST` and `PORT` configure the Node listener; the container listens on `0.0.0.0:3000` internally.

`SESSION_SECRET` is optional. Set a random value of at least 32 characters if logins should remain valid across server restarts. Without it, a fresh key is generated at startup. Changing the password requires a restart; also change the session secret to revoke existing sessions immediately.

## Data and checks

The CSV schema is:

```csv
id,captured_at,sys,dia,pul,arm
```

SYS and DIA are in mmHg; PUL is in beats per minute. Each accepted reading has a UUID. Uploading the same photo twice creates two readings. Downloads include the full history. Empty files are initialized on first save; malformed, non-empty CSV files are rejected without being overwritten.

```sh
npm run check
npm audit
```

Tests use generated monitor images to cover two- and three-digit values, rotation, resizing, incomplete digits, error displays and saving recognized values through the API into the CSV. No personal photos or reading history are included. Accuracy across a larger set of real phone photos has not yet been established.

The tracker is licensed under the [MIT License](LICENSE). The bundled English OCR model is separately licensed under [Apache-2.0](assets/tessdata/LICENSE); its source revision and checksum are documented in [assets/tessdata/README.md](assets/tessdata/README.md).
