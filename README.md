# GROUP-LOCK: Intelligent Group Safety & Real-Time Convoy Coordination System

[![Status: Production Ready](https://img.shields.io/badge/Status-Production%20Ready-brightgreen.svg)]()
[![Stack: MERN + Socket.IO](https://img.shields.io/badge/Stack-MERN%20%2B%20Socket.IO-blue.svg)]()
[![AI: Primus Voice Assistant](https://img.shields.io/badge/AI-Primus%20Voice%20Copilot-orange.svg)]()
[![Academic: KTU MCA 2026](https://img.shields.io/badge/Academic-KTU%20MCA%202026-purple.svg)]()

> **Final Mini Project Submission**  
> **APJ Abdul Kalam Technological University (KTU), Kerala**  
> **Department of Computer Applications, Sree Narayana Gurukulam College of Engineering (SNGCE)**

---

## 📋 Academic Submission Metadata

| Attribute | Submission Detail |
|---|---|
| **Project Title** | GROUP-LOCK: Intelligent Group Safety and Real-Time Convoy Coordination System |
| **Student Name** | **ALBIN ANTONY** |
| **Register Number** | **SNG25MCA-2014** |
| **Class / Batch** | **S3-A** |
| **Group Identifier** | **A2** (Individual Project) |
| **Faculty Guide** | **Mr. Anoopkumar M**, Assistant Professor, Dept. of Computer Applications |
| **Academic Year** | **2026** |
| **Prescribed Report** | [`2026_A2_SNG25MCA-2014_AlbinAntony_S3-A_GROUP-LOCK.pdf`](./2026_A2_SNG25MCA-2014_AlbinAntony_S3-A_GROUP-LOCK.pdf) |
| **Department Deadline** | Hardbound submission (Light Blue Cover) on or before **10 November 2026** |

---

## 🧭 Project Abstract & Overview

**GROUP-LOCK** is a real-time web application engineered to unify convoy telemetry, automated geospatial separation monitoring, instant in-ride messaging, and hands-free voice assistance into a single high-reliability platform.

During group motorcycle touring, vehicular convoys frequently suffer from route disorientation, trailing stragglers in low network coverage zones, and dangerous roadside distractions caused by riders fumbling with handheld touchscreens. GROUP-LOCK addresses these challenges through:

1. **Sub-100ms Live Telemetry Streaming**: Event-driven WebSocket Secure (WSS) engine utilizing Socket.IO, continuously synchronizing GPS coordinates, headings, and instant velocities across all convoy participants.
2. **Automated "Group-Lock" Separation Warnings**: Server-side in-memory spatial cache continuously running the Haversine distance algorithm to detect trailing riders exceeding predetermined safe convoy thresholds.
3. **High-Priority Emergency SOS Broadcast**: Single-tap and voice-activated panic broadcast that immediately plays audible siren alerts, logs distress events to MongoDB, and pushes live emergency coordinates to all convoy members.
4. **PRIMUS AI Copilot**: Voice-driven conversational assistant built with Web Speech Recognition APIs and intelligent intent parsing (with Anthropic Claude API fallback) enabling 100% hands-free operational queries (weather, remaining distance, ETA, nearest fuel, or calling the ride leader).
5. **Cryptographic Group Access**: 24-hour self-expiring alphanumeric invite codes generated via secure random entropy.
6. **Stateless Dual-Token Authentication**: JWT Access Tokens (15m expiry) paired with Refresh Tokens (7d expiry) and automatic silent client renewals.

---

## 🛠️ Technology Stack

| Layer | Technologies Employed |
|---|---|
| **Frontend Client** | React 18, Vite 5, Tailwind CSS, Leaflet GIS, React Router DOM v6, Socket.IO Client, Web Speech API |
| **Backend API Server** | Node.js (v18+), Express.js 4, Socket.IO 4, Mongoose 8 |
| **Database & Cache** | MongoDB 7.0 / MongoDB Atlas, In-Memory Geospatial Spatial Cache |
| **Security & Auth** | JSON Web Tokens (Access + Refresh), Bcrypt (10 Salt Rounds), Express Rate Limit |
| **Geospatial & Mapping** | OpenStreetMap, Leaflet.js, Open Source Routing Machine (OSRM), Google Places API / OSM Photon |
| **AI Engine** | PRIMUS Hybrid Brain (Local Rule/Regex Intent Parser + Claude 3.5 Haiku Fallback) |

---

## ⚙️ Configuration and Execution Guide

Follow these step-by-step instructions to configure, install dependencies, and execute the application locally.

### 1. Prerequisites

Ensure you have the following installed on your host workstation:
- **Node.js**: v18.16.0 or higher ([Download Node.js](https://nodejs.org/))
- **npm**: v9.0.0 or higher (bundled with Node.js)
- **MongoDB**: Local MongoDB Community Server running on `mongodb://127.0.0.1:27017` OR a free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) cluster connection URI.
- **Git**: v2.30+ ([Download Git](https://git-scm.com/))
- **Modern Web Browser**: Google Chrome, Microsoft Edge, or Chromium (required for HTML5 Geolocation and Web Speech Recognition support).

---

### 2. Clone the Repository

```bash
git clone https://github.com/chatthan/GROUP-LOCK.git
cd GROUP-LOCK
```

---

### 3. Backend Configuration & Setup

1. Open a terminal and navigate to the `server` directory:
   ```bash
   cd server
   ```

2. Copy the sample environment file to `.env`:
   ```bash
   cp .env.example .env
   # On Windows Command Prompt:
   copy .env.example .env
   ```

3. Configure your `server/.env` parameters:
   ```env
   # Server Port and Environment
   PORT=5000
   NODE_ENV=development

   # Database Connection URI (Local or Atlas)
   MONGO_URI=mongodb://127.0.0.1:27017/grouplock

   # JWT Authentication Secrets
   JWT_ACCESS_SECRET=grouplock_jwt_super_secure_access_secret_2026_xyz
   JWT_REFRESH_SECRET=grouplock_jwt_super_secure_refresh_secret_2026_abc
   JWT_ACCESS_EXPIRY=15m
   JWT_REFRESH_EXPIRY=7d

   # CORS Allowed Origins
   CLIENT_ORIGIN=http://localhost:5173

   # (Optional) Primus AI Cloud Fallback & Google Places
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   PRIMUS_MODEL=claude-haiku-5-5
   PRIMUS_WEB_SEARCH=true
   GOOGLE_MAPS_API_KEY=your_google_maps_key_here
   ```
   > **Note**: An Anthropic API key is optional. When omitted, all core ride features, convoy tracking, straggler alerts, SOS broadcast, and local regex-based voice commands (e.g., weather, group status, emergency) function seamlessly.

4. Install backend dependencies:
   ```bash
   npm install
   ```

---

### 4. Frontend Configuration & Setup

1. Open a second terminal and navigate to the `client` directory:
   ```bash
   cd client
   ```

2. Copy the sample environment file to `.env`:
   ```bash
   cp .env.example .env
   # On Windows Command Prompt:
   copy .env.example .env
   ```

3. Verify your `client/.env` configuration:
   ```env
   VITE_API_URL=http://localhost:5000/api
   VITE_SOCKET_URL=http://localhost:5000
   VITE_GOOGLE_MAPS_API_KEY=
   ```

4. Install frontend dependencies:
   ```bash
   npm install
   ```

---

### 5. Running the Application

You can execute the entire system using either the **One-Click Windows Launcher** or **Manual Dual-Terminal Execution**.

#### Option A: One-Click Windows Launcher (Recommended)
Double-click [`start-grouplock.bat`](./start-grouplock.bat) in the project root directory, or run from terminal:
```cmd
start-grouplock.bat
```
This batch script will automatically spawn separate command windows for both the Express/Socket.IO backend server on port `5000` and the Vite React development server on port `5173`.

#### Option B: Manual Execution via Terminal

**Terminal 1 (Backend Server):**
```bash
cd server
npm run dev
```
*Expected Output:*
```
[Database] MongoDB Connected: 127.0.0.1:27017 / grouplock
[Server] GROUP-LOCK API & WebSocket Engine listening on port 5000
```

**Terminal 2 (Frontend Client):**
```bash
cd client
npm run dev
```
*Expected Output:*
```
  VITE v5.3.4  ready in 320 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

---

### 6. Verification and Health Check

1. **Verify Backend API**:
   Open a browser or run `curl`:
   ```bash
   curl http://localhost:5000/api/health
   ```
   Expected JSON response:
   ```json
   {
     "success": true,
     "message": "GROUP-LOCK API is running",
     "db": "connected"
   }
   ```

2. **Access Web Application**:
   Open [http://localhost:5173](http://localhost:5173) in your browser.
   - Register a new rider account (must be 18+ years of age).
   - Create a new riding group (you will be designated Group Admin).
   - Generate a 24-hour invite code to allow other devices to join.
   - Create and schedule a ride with waypoints.
   - Click **Live Convoy** to mount the interactive Leaflet GPS Cockpit.

---

## 🧪 Testing & Quality Assurance Suite

The repository includes comprehensive automated test suites covering stress testing, latency, timeout handling, and telemetry simulation.

To execute the automated backend test suite:
```bash
cd server
npm test
```

### Specialized Test Execution:

1. **Production Stress Test (High Concurrency Socket Emulation)**:
   ```bash
   node server/scripts/stress_test.js
   ```
   *Simulates concurrent riders streaming live GPS updates to verify sub-100ms processing.*

2. **Network Timeout & Disconnect Test**:
   ```bash
   node server/scripts/timeout_test.js
   ```
   *Simulates network dropouts and validates automated network-loss alerts.*

3. **Multi-Rider Convoy Simulator**:
   ```bash
   node server/scripts/simulate-convoy.js
   ```
   *Simulates a multi-bike convoy travelling along real Kerala highways with straggler deviations.*

4. **Primus Voice Copilot Security Verification**:
   ```bash
   node server/scripts/test_primus_security.js
   ```

---

## 📂 Repository Directory Structure

```
GROUP-LOCK/
├── 2026_A2_SNG25MCA-2014_AlbinAntony_S3-A_GROUP-LOCK.pdf   # Prescribed Final Project Report (110 Pages)
├── README.md                                              # System Configuration & Execution Guide
├── start-grouplock.bat                                    # Automated Dual-Service Windows Launcher
├── .gitignore                                             # Version Control Ignore Rules
│
├── client/                                                # React 18 Single-Page Application (Frontend)
│   ├── public/                                            # Public static assets & mascots
│   ├── src/
│   │   ├── components/                                    # UI Components (HUD, Speedometer, SOS, Map)
│   │   │   ├── CreateGroupForm.jsx                        # Group creation modal
│   │   │   ├── CreateRideForm.jsx                         # Ride waypoint & route planner
│   │   │   ├── GroupCard.jsx                              # Group cards with role badges
│   │   │   ├── JoinGroupForm.jsx                          # 6-char cryptographic invite entry
│   │   │   ├── Navbar.jsx                                 # Navigation header with active status
│   │   │   ├── PlaceAutocompleteInput.jsx                 # OSM Photon / Google Places search
│   │   │   ├── ProtectedRoute.jsx                         # JWT Auth gatekeeper
│   │   │   ├── RideCard.jsx                               # Live Ride status launcher
│   │   │   └── RouteMapPreview.jsx                        # OSRM Polyline route visualizer
│   │   ├── context/
│   │   │   └── AuthContext.jsx                            # Global auth state & silent token refresh
│   │   ├── pages/
│   │   │   ├── DashboardPage.jsx                          # User overview & quick launch
│   │   │   ├── GroupDetailsPage.jsx                       # Group management & member promotion
│   │   │   ├── LandingPage.jsx                            # Public landing page with features
│   │   │   ├── LiveRidePage.jsx                           # Live convoy cockpit (Leaflet HUD, SOS, Chat)
│   │   │   ├── LoginPage.jsx                              # Secure rider login
│   │   │   ├── RegisterPage.jsx                           # Rider registration (18+ validation)
│   │   │   └── RideHistoryPage.jsx                        # Completed ride telemetry archives
│   │   ├── services/
│   │   │   ├── api.js                                     # Axios HTTP client with 401 interceptor
│   │   │   ├── auth.service.js                            # Auth API client
│   │   │   ├── group.service.js                           # Group API client
│   │   │   ├── ride.service.js                            # Ride & OSRM routing API client
│   │   │   └── socket.service.js                          # Socket.IO client singleton
│   │   ├── App.jsx                                        # React Router root definitions
│   │   └── main.jsx                                       # DOM entry point
│   ├── package.json                                       # Client package definitions
│   ├── tailwind.config.js                                 # Tailwind styling configurations
│   └── vite.config.js                                     # Vite build configurations
│
└── server/                                                # Express.js & Socket.IO Backend
    ├── scripts/                                           # Automated QA & Convoy Simulation Suites
    │   ├── inspect_db.js                                  # Database schema inspector
    │   ├── simulate-convoy.js                             # Multi-rider GPS convoy generator
    │   ├── stress_test.js                                 # Concurrency stress tester
    │   ├── test_primus_security.js                        # Voice AI prompt injection tester
    │   ├── timeout_test.js                                # Socket timeout & disconnect tester
    │   └── verify_ride_history.js                         # Ride archiving verifier
    ├── src/
    │   ├── config/
    │   │   ├── db.js                                      # MongoDB Mongoose connection manager
    │   │   └── env.js                                     # Centralized environment variable parser
    │   ├── controllers/
    │   │   ├── auth.controller.js                         # Register, login, refresh, getMe
    │   │   ├── group.controller.js                        # Groups CRUD, invite codes, promote
    │   │   └── ride.controller.js                         # Rides lifecycle, history, geocoding
    │   ├── middleware/
    │   │   ├── auth.middleware.js                         # JWT verification & role authorization
    │   │   └── errorHandler.js                            # Global error handling middleware
    │   ├── models/
    │   │   ├── Alert.js                                   # SOS & Network-Loss schema
    │   │   ├── Group.js                                   # Group & membership schema
    │   │   ├── Message.js                                 # In-ride persistent chat schema
    │   │   ├── Ride.js                                    # Ride lifecycle & waypoint schema
    │   │   ├── RideHistory.js                             # Archived ride summary schema
    │   │   └── User.js                                    # Rider profile & credential schema
    │   ├── routes/
    │   │   ├── alert.routes.js                            # Alert resolution endpoints
    │   │   ├── auth.routes.js                             # Rate-limited auth endpoints
    │   │   ├── group.routes.js                            # Group management endpoints
    │   │   ├── message.routes.js                          # In-ride chat endpoints
    │   │   └── ride.routes.js                             # Ride lifecycle endpoints
    │   ├── services/
    │   │   ├── invite.service.js                          # 24h cryptographic invite generator
    │   │   ├── primusBrain.service.js                     # Hybrid Voice AI parser & Claude fallback
    │   │   ├── simulation.service.js                      # In-ride simulation utilities
    │   │   ├── token.service.js                           # Dual-token JWT creation & verification
    │   │   └── tunnel.service.js                          # Local tunneling support
    │   ├── sockets/
    │   │   └── ride.socket.js                             # Socket.IO room lifecycle, GPS cache, SOS
    │   ├── app.js                                         # Express application setup
    │   └── server.js                                      # HTTP & WebSocket Secure server entry
    └── package.json                                       # Server package definitions
```

---

## 📡 REST API & Real-Time Event Protocols

### RESTful Endpoints

| Category | Method | Path | Authentication | Description |
|---|---|---|---|---|
| **System** | `GET` | `/api/health` | None | API health status and MongoDB connection state |
| **Auth** | `POST` | `/api/auth/register` | None (Rate Limited) | Creates rider account (enforces 18+ requirement) |
| **Auth** | `POST` | `/api/auth/login` | None (Rate Limited) | Authenticates rider, returns access & refresh tokens |
| **Auth** | `POST` | `/api/auth/refresh` | None | Silently generates fresh access token from refresh token |
| **Auth** | `GET` | `/api/auth/me` | Bearer Token | Retrieves authenticated rider profile |
| **Groups** | `POST` | `/api/groups` | Bearer Token | Creates a new group; creator becomes admin |
| **Groups** | `GET` | `/api/groups` | Bearer Token | Lists all groups joined by the authenticated rider |
| **Groups** | `POST` | `/api/groups/join` | Bearer Token | Joins group using 6-character cryptographic invite code |
| **Groups** | `GET` | `/api/groups/:id` | Bearer Token | Retrieves group details and member roster |
| **Groups** | `POST` | `/api/groups/:id/regenerate-invite`| Admin Only | Generates a new 24-hour expiring invite code |
| **Groups** | `POST` | `/api/groups/:id/promote/:userId` | Admin Only | Promotes a standard group member to group admin |
| **Rides** | `POST` | `/api/rides` | Group Member | Schedules a ride with waypoints and planned route |
| **Rides** | `GET` | `/api/rides/:id` | Group Member | Retrieves single ride details and participants |
| **Rides** | `POST` | `/api/rides/:id/join` | Group Member | Adds authenticated rider to ride roster |
| **Rides** | `POST` | `/api/rides/:id/start` | Admin / Lead | Initiates ride; transitions status to `ongoing` |
| **Rides** | `POST` | `/api/rides/:id/end` | Admin / Lead | Terminates ride; archives metrics to `RideHistory` |
| **Rides** | `POST` | `/api/rides/:id/cancel` | Admin / Lead | Cancels scheduled ride |
| **Rides** | `GET` | `/api/rides/history/:groupId` | Group Member | Lists completed ride telemetry archives |
| **Chat** | `GET` | `/api/rides/:id/messages` | Ride Member | Retrieves latest 100 persistent in-ride messages |
| **Alerts** | `GET` | `/api/rides/:id/alerts` | Ride Member | Retrieves active SOS and network-loss alerts |
| **Alerts** | `PATCH`| `/api/alerts/:id/resolve` | Ride Member | Resolves emergency SOS alert |

### Socket.IO Event Reference

| Event Name | Direction | Payload Structure | Functional Purpose |
|---|---|---|---|
| `join_ride` | Client → Server | `{ rideId }` | Authenticates connection and joins real-time ride room |
| `leave_ride` | Client → Server | `{ rideId }` | Exits ride room and informs convoy members |
| `location:update` | Client → Server | `{ rideId, lat, lng, speed, heading }` | Streams rider GPS telemetry to server cache |
| `rider:location_update` | Server → Client | `{ userId, name, lat, lng, speed, heading }` | Broadcasts live position of another rider |
| `chat:send` | Client → Server | `{ rideId, text }` | Dispatches in-ride chat; persists to database |
| `chat:new_message` | Server → Client | `{ _id, sender, text, createdAt }` | Delivers new chat message to convoy chat drawer |
| `sos:trigger` | Client → Server | `{ rideId, reason, lat, lng }` | Dispatches high-priority panic broadcast across convoy |
| `sos:alert` | Server → Client | `{ alertId, user, reason, coords, timestamp }` | Plays audible siren and presents modal warning |
| `sos:resolve` | Client → Server | `{ alertId, rideId }` | Dismisses active emergency alert across all devices |
| `rider:disconnected` | Server → Client | `{ userId, name, lastSeen }` | Notifies convoy when rider suffers connection loss |

---

## 📄 Submission Verification & Project Report

- **Digital Project Report (PDF)**:
  Included at root: [`2026_A2_SNG25MCA-2014_AlbinAntony_S3-A_GROUP-LOCK.pdf`](./2026_A2_SNG25MCA-2014_AlbinAntony_S3-A_GROUP-LOCK.pdf)  
  *Complies strictly with KTU guidelines: 110 pages containing Problem Concept, Product Backlog, Fibonacci Story Points, Sprint Execution Logs (S1–S6), Daily Scrum Registers, Burndown Charts, Supertest API Matrices, and Architecture Schematics.*
- **Hardbound Copy**:
  Prepared for submission to the SNGCE Department Library with a Light Blue Cover on or before **10 November 2026**.

---

## 👤 Author & Academic Mentorship

- **Developer**: **ALBIN ANTONY** (Roll No: SNG25MCA-2014)  
  *Master of Computer Applications (MCA), Class S3-A, Group A2*  
  Sree Narayana Gurukulam College of Engineering, Kadayiruppu, Kerala  
  Email: [albinantony502@gmail.com](mailto:albinantony502@gmail.com)
- **Project Guide**: **Mr. Anoopkumar M**, Assistant Professor, Dept. of Computer Applications
- **Department Coordinator**: **Ms. Jisha Abraham**, Dept. of Computer Applications
