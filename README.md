# बातचीत

Private real-time chat (React + Express + Socket.IO + MongoDB). Translucent glass UI, rounded panels, dark/light with separate aurora / sun animations.

> **Private repo** — do not mirror. Origin is `rizzhan/chat-app` (private).

## Stack
- Client: Vite + React 19 + Tailwind 4 + motion
- Server: Express 5 + Socket.IO 4 + Mongoose 9 + helmet + rate-limit

## Run
```bash
# server
cp server/.env.example server/.env  # fill MONGO_URI / JWT_SECRET (64-char hex)
npm --prefix server install
npm --prefix server run dev

# client
cp client/.env.example client/.env  # VITE_SERVER_URL=http://localhost:5000
npm --prefix client install
npm --prefix client run dev
```

## Security
- `JWT_SECRET` >=32 chars, 1d expiry, helmet, CORS allowlist, upload MIME filter, auth 10/15min rate-limit. Rotate Atlas password after cloning.

## Version
Glass + rounded + auth animations (light: sun/bubbles, dark: stars)
