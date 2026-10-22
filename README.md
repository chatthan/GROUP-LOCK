# GROUP-LOCK — Full Project (Phases 1–5)

Real-time group ride tracking, coordination, and safety platform.

---

# Phase 1 — Project Initialization & Database Foundation

Project setup, database models, and health check. No auth, groups, rides, chat, maps, or SOS yet.

## What's in this phase

**Backend** (`/server`)
- Express app with central error handling (`middleware/errorHandler.js`)
- MongoDB connection via Mongoose (`config/db.js`), fails fast if unreachable
- Centralized env config (`config/env.js`) — nothing reads `process.env` directly elsewhere
- `GET /api/health` — returns API status + live DB connection state
- 6 Mongoose models (see relationships below)

**Frontend** (`/client`)
- Vite + React + Tailwind + React Router
- Layout + Navbar, three placeholder pages (Landing, Login, Register)
- `services/api.js` — single place holding the API base URL for later phases

## Model relationships & design choices

- **User** — core identity. `passwordHash` has `select: false` and is stripped again in `toJSON()` so it can never leak into an API response by accident.
- **Group** — membership is an embedded array on the Group document (`{user, role, joinedAt}`), not a separate collection.
- **Ride** — references `Group`, has a `participants` array and `status`. Deliberately holds no location/route data in Phase 1.
- **Message** and **Alert** — both scoped to `ride` (primary) with `group` kept alongside for convenient filtering.
- **RideHistory** — a denormalized summary (distance, duration, member count, participants) created once a ride ends.

## How to run

### Prerequisites
- Node.js 18+
- MongoDB running locally (`mongod`) or a MongoDB Atlas connection string

### Backend
```bash
cd server
cp .env.example .env
# edit .env — set MONGO_URI, JWT_ACCESS_SECRET
npm install
npm run dev
```

### Frontend
```bash
cd client
cp .env.example .env
npm install
npm run dev
```

---

# Phase 2 — Authentication & User System

Real registration, login, JWT auth middleware, `/api/auth/me`, and the full frontend auth flow.

## Files created

**Backend**
- `src/validators/auth.validators.js`
- `src/services/token.service.js`
- `src/middleware/auth.middleware.js` — `authenticate` + `authorize(...roles)`
- `src/controllers/auth.controller.js` — `register`, `login`, `getMe`
- `src/routes/auth.routes.js`

**Frontend**
- `src/services/auth.service.js`
- `src/context/AuthContext.jsx`
- `src/components/ProtectedRoute.jsx`
- `src/pages/DashboardPage.jsx`
- `src/utils/validators.js`

## API endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | none | Returns 201 + token + safe user. |
| POST | `/api/auth/login` | none | Returns 200 + token. Generic 401 for both wrong email and wrong password. |
| GET | `/api/auth/me` | Bearer token | Returns authenticated user's safe profile. |

## Security notes

- Passwords hashed with bcrypt (10 salt rounds).
- JWT payload is `{id, role}` only.
- Registration hard-codes `role: 'rider'` server-side.
- Frontend stores JWT in `localStorage`.

---

# Phase 3 — Group Management Module

Real group creation, invite-code join flow, membership listing, group details, leave, and admin-only invite regeneration.

## Files created

**Backend**
- `src/validators/group.validators.js`
- `src/services/invite.service.js` — secure invite code generation (`crypto.randomInt`, 24-hour expiry)
- `src/controllers/group.controller.js`
- `src/routes/group.routes.js`

**Frontend**
- `src/services/group.service.js`
- `src/components/GroupCard.jsx`, `CreateGroupForm.jsx`, `JoinGroupForm.jsx`
- `src/pages/GroupDetailsPage.jsx`

## API endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/groups` | required | body: `{name}`. Creator auto-added as `admin`. |
| GET | `/api/groups` | required | Groups where the caller is a member. |
| POST | `/api/groups/join` | required | body: `{inviteCode}`. |
| GET | `/api/groups/:id` | required, member-only | Invite code only shown to admins. |
| POST | `/api/groups/:id/leave` | required, member-only | Blocks if caller is last admin. |
| POST | `/api/groups/:id/regenerate-invite` | required, admin-only | New code + new 24h expiry. |
| POST | `/api/groups/:id/promote/:userId` | required, admin-only | Promote a member to admin. |

---

# Phase 4 — Ride Management Module

Full ride creation, lifecycle state management (`planned` → `ongoing` → `completed` / `cancelled`), participant tracking, start/end/cancel controls, and auto-generation of `RideHistory` records.

## Files created

**Backend**
- `src/validators/ride.validators.js`
- `src/controllers/ride.controller.js`
- `src/routes/ride.routes.js`

**Frontend**
- `src/services/ride.service.js`
- `src/components/CreateRideForm.jsx`
- `src/components/RideCard.jsx`
- `src/components/RouteMapPreview.jsx`
- `src/components/PlaceAutocompleteInput.jsx`

## API endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/rides` | required, member-only | Creates ride in `planned` state. |
| GET | `/api/rides/group/:groupId` | required, member-only | Optional `?status=` filter. |
| GET | `/api/rides/history/:groupId` | required, member-only | Completed ride history, limit 50. |
| GET | `/api/rides/:id` | required, member-only | Single ride with populated participants. |
| GET | `/api/rides/:id/messages` | required | Last 100 chat messages for a ride. |
| GET | `/api/rides/:id/alerts` | required | Unresolved SOS/network-loss alerts. |
| POST | `/api/rides/:id/join` | required, member-only | Adds caller to participants. |
| POST | `/api/rides/:id/start` | required, admin/creator | `planned` → `ongoing`. |
| POST | `/api/rides/:id/end` | required, admin/creator | `ongoing` → `completed`, creates RideHistory. |
| POST | `/api/rides/:id/cancel` | required, admin/creator | `planned` → `cancelled`. |
| POST | `/api/rides/:id/share-location` | required | Shares pre-ride location pin to map. |
| GET | `/api/rides/places-autocomplete` | required | `?query=` — Google Places or OSM Photon fallback. |

---

# Phase 5 — Live Convoy Tracking, Real-Time GPS & Safety Module

Real-time multi-rider live GPS streaming, interactive convoy tracking map, in-memory location caching, separation/straggler warnings ("Group-Lock"), in-ride team chat, emergency SOS broadcast, network-loss alerts, token refresh, rate limiting, and ride history UI.

## Files created

**Backend**
- `src/sockets/ride.socket.js` — Socket.IO server with JWT handshake auth, ride rooms, GPS cache, chat persistence, SOS broadcast, network-loss alerts on disconnect.
- `src/routes/message.routes.js` — `GET /api/messages?rideId=`
- `src/routes/alert.routes.js` — `GET /api/alerts?rideId=`, `PATCH /api/alerts/:id/resolve`

**Frontend**
- `src/services/socket.service.js` — Socket.IO client singleton with auto-reconnect and JWT auth.
- `src/pages/LiveRidePage.jsx` — Full-screen live convoy map (Leaflet), multi-rider moving markers, digital speedometer, straggler warning banner, slide-over chat drawer, SOS system, manual GPS pin adjustment.
- `src/pages/RideHistoryPage.jsx` — Past rides list with stats (distance, duration, participants, date).

## Files modified in Phase 5

**Backend**
- `src/server.js` — Attached `socket.io` to Express via `http.createServer(app)`.
- `src/controllers/ride.controller.js` — Added `getRideHistory`, `cancelRide`, `getRideMessages`, `getRideAlerts`, `getPlacesAutocomplete`, `shareRiderLocation`.
- `src/controllers/group.controller.js` — Added `promoteMember`.
- `src/controllers/auth.controller.js` — Added `refreshAccessToken`; login now returns `refreshToken`.
- `src/routes/ride.routes.js` — Registered all new ride endpoints.
- `src/routes/group.routes.js` — Added promote endpoint.
- `src/routes/auth.routes.js` — Added `POST /refresh`; rate-limited register + login (10 req/15 min).
- `src/services/token.service.js` — Added `signRefreshToken` + `verifyRefreshToken`.
- `src/app.js` — Mounted `/api/messages` and `/api/alerts`.
- `package.json` — Added `express-rate-limit@^7.4.0`, `socket.io@^4.7.5`.

**Frontend**
- `src/App.jsx` — Added `/rides/:id/live` and `/groups/:id/history` routes.
- `src/pages/LandingPage.jsx` — Full hero page with features and CTAs.
- `src/pages/GroupDetailsPage.jsx` — Ride History link, Promote button, rides pagination.
- `src/components/RideCard.jsx` — Live Convoy button, Cancel Ride button, location sharing.
- `src/services/ride.service.js` — Added `getRideHistory`, `cancelRide`, `geocodePlace`, `fetchRouteGeometry`, `getRideMessages`, `getRideAlerts`, `getPlaceSuggestions`, `shareRiderLocation`.
- `src/services/group.service.js` — Added `promoteMember`.
- `src/services/auth.service.js` — Added `refreshToken`.
- `src/services/api.js` — Silent 401 retry with refresh token.
- `src/context/AuthContext.jsx` — Refresh token lifecycle (store, use, clear).

## Real-Time Socket.IO Events

| Event | Direction | Description |
|---|---|---|
| `join_ride` | Client → Server | Joins ride room, receives current active riders snapshot. |
| `leave_ride` | Client → Server | Leaves room and notifies others. |
| `location:update` | Client → Server | Streams `{rideId, lat, lng, speed, heading}`. Server updates in-memory cache and broadcasts `rider:location_update`. |
| `chat:send` | Client → Server | Emits text message, saves to MongoDB, broadcasts `chat:new_message`. |
| `sos:trigger` | Client → Server | Broadcasts high-priority SOS, saves `Alert` doc. |
| `sos:resolve` | Client → Server | Resolves alert across all convoy members. |
| `rider:location_update` | Server → Client | Live GPS position of another rider. |
| `rider:joined` | Server → Client | A new rider joined the convoy. |
| `rider:left` | Server → Client | A rider manually left. |
| `rider:disconnected` | Server → Client | A rider lost connection (+ network-loss Alert saved). |
| `ride:started` | Server → Client | Ride status changed to `ongoing`. |
| `ride:ended` | Server → Client | Ride marked `completed`. |
| `ride:cancelled` | Server → Client | Ride marked `cancelled`. |
| `sos:alert` | Server → Client | Emergency SOS or network-loss alert broadcast. |
| `sos:resolved` | Server → Client | Alert resolved. |
| `chat:new_message` | Server → Client | New chat message in ride room. |

## How to run (Phase 5)

### Prerequisites
- Node.js 18+
- MongoDB running locally or Atlas URI
- (Optional) Google Maps API key for Places autocomplete

### Backend
```bash
cd server
npm install
npm run dev
```

### Frontend
```bash
cd client
npm install
npm run dev
```

### Required `.env` — Server
```
MONGO_URI=mongodb://127.0.0.1:27017/grouplock
JWT_ACCESS_SECRET=your_access_secret_here
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_SECRET=your_refresh_secret_here
JWT_REFRESH_EXPIRY=7d
CLIENT_ORIGINS=http://localhost:5173
PORT=5000
NODE_ENV=development
# Optional:
GOOGLE_MAPS_API_KEY=your_google_maps_key
```

### Required `.env` — Client
```
VITE_API_URL=http://localhost:5000/api
```

### Health check
```bash
curl http://localhost:5000/api/health
# Expected: {"success":true,"message":"GROUP-LOCK API is running","db":"connected"}
```

## Security features in Phase 5

- JWT access tokens (15 min) + refresh tokens (7 days) with silent renewal on 401.
- Rate limiting: max 10 login/register attempts per IP per 15 minutes.
- Socket.IO connections authenticated via JWT handshake before any room events fire.
- Every group/ride action verifies membership from JWT — no client-supplied user IDs trusted.
- `network-loss` alerts saved to DB and broadcast when a rider unexpectedly disconnects mid-ride.

## Feature summary (all phases combined)

| Feature | Status |
|---|---|
| User registration & login | ✅ |
| JWT auth + silent refresh | ✅ |
| Rate-limited auth routes | ✅ |
| Edit profile (name, phone, bio, blood group, photo URL) | ✅ |
| Group creation & invite-code join | ✅ |
| Group member management + admin promotion | ✅ |
| Ride scheduling (title, route, distance) | ✅ |
| Pre-ride location sharing on map | ✅ |
| Start / End / Cancel ride | ✅ |
| Live GPS convoy map (Leaflet, real-time) | ✅ |
| Multi-rider moving markers with avatars | ✅ |
| Digital speedometer | ✅ |
| Straggler / Group-Lock warning banner | ✅ |
| In-ride team chat | ✅ |
| Emergency SOS broadcast | ✅ |
| Network-loss alerts | ✅ |
| Ride History page | ✅ |
| Places autocomplete (Google Maps / OSM fallback) | ✅ |
| Route preview map (OSRM) | ✅ |
