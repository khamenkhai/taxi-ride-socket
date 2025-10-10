// backend.ts
import { Server } from "socket.io";
import http from "http";

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// ---------------- Interfaces ----------------

interface Location {
  lat: number;
  lng: number;
  address?: string; // optional human-readable address
}

interface Destination extends Location {
  status?: "pending" | "completed"; // ✅ only two statuses
}

interface Ride {
  rideId: string;
  userId: string;
  driverId?: string;
  status?:
    | "requested"
    | "accepted"
    | "driverArrived"
    | "inProgress"
    | "completed"
    | "cancelled";
  driverLocation?: Location;
  pickupLocation?: Location;
  destinations?: Destination[];
  currentIndex?: number; // ✅ track active destination
  createdAt?: number;
}

interface Driver {
  driverId: string;
  socketId: string;
  online: boolean;
}

// ---------------- Memory Storage ----------------

const drivers: Record<string, Driver> = {};
const rides: Record<string, Ride> = {};
const rideTimers: Record<string, NodeJS.Timeout[]> = {};

// ---------------- Socket Events ----------------

io.on("connection", (socket) => {
  console.log("🔗 Client connected:", socket.id);

  // ----- Driver registers -----
  socket.on("registerDriver", ({ driverId }) => {
    console.log("📝 Driver registered:", driverId);
    drivers[driverId] = { driverId, socketId: socket.id, online: true };
    socket.join(driverId);

    io.emit("driverStatusChanged", { driverId, online: true });

    // Auto-sync any ongoing ride
    const activeRide = Object.values(rides).find(
      (r) =>
        r.driverId === driverId &&
        ["accepted", "driverArrived", "inProgress"].includes(r.status!)
    );
    if (activeRide) {
      socket.emit(`ride_${activeRide.rideId}`, activeRide);
      console.log(
        `🔄 Auto-synced ride ${activeRide.rideId} for driver ${driverId}`
      );
    }
  });

  // ----- User registers -----
  socket.on("registerUser", ({ userId }) => {
    socket.join(userId);
    console.log("📝 User registered:", userId);

    const activeRide = Object.values(rides).find(
      (r) =>
        r.userId === userId &&
        ["requested", "accepted", "driverArrived", "inProgress"].includes(
          r.status!
        )
    );
    if (activeRide) {
      socket.emit(`ride_${activeRide.rideId}`, activeRide);
      console.log(
        `🔄 Auto-synced user ride ${activeRide.rideId} for user ${userId}`
      );
    }
  });

  // ----- Driver online/offline -----
  socket.on("driverOffline", ({ driverId }) => {
    const driver = drivers[driverId];
    if (driver) {
      driver.online = false;
      io.emit("driverStatusChanged", { driverId, online: false });
      console.log(`🛑 Driver ${driverId} went offline`);
    }
  });

  socket.on("driverOnline", ({ driverId }) => {
    const driver = drivers[driverId];
    if (driver) {
      driver.online = true;
      io.emit("driverStatusChanged", { driverId, online: true });
      console.log(`✅ Driver ${driverId} is online`);
    }
  });

  // ----- Disconnect -----
  socket.on("disconnect", () => {
    const driver = Object.values(drivers).find((d) => d.socketId === socket.id);
    if (driver) {
      driver.online = false;
      io.emit("driverStatusChanged", {
        driverId: driver.driverId,
        online: false,
      });
      console.log(`❌ Driver disconnected and set offline: ${driver.driverId}`);
    }
    console.log("❌ Client disconnected:", socket.id);
  });

  // ---------------- Rides ----------------

  // Request ride
  socket.on("rideRequested", (ride) => {
    ride.status = "requested";
    ride.createdAt = Math.floor(Date.now() / 1000);

    // ✅ Initialize destinations (max 4, all pending)
    if (Array.isArray(ride.destinations)) {
      ride.destinations = ride.destinations
        .slice(0, 4)
        .map((d: Destination) => ({
          ...d,
          status: "pending",
        }));
      ride.currentIndex = 0;
    }

    rides[ride.rideId] = ride;
    rideTimers[ride.rideId] = [];

    // 🪵 Log full ride JSON
    console.log("🚕 New Ride Requested:");
    console.log(JSON.stringify(ride, null, 2));

    // Send to all free and online drivers
    Object.values(drivers).forEach((driver) => {
      const driverIsOnline = driver.online;
      const driverIsFree = !Object.values(rides).some(
        (r) =>
          r.driverId === driver.driverId &&
          ["accepted", "driverArrived", "inProgress"].includes(r.status!)
      );

      if (driverIsOnline && driverIsFree) {
        io.to(driver.driverId).emit("rideRequested", ride);
        console.log(`📤 Ride ${ride.rideId} sent to driver ${driver.driverId}`);

        const timer = setTimeout(() => {
          console.log(
            `⏱ Driver ${driver.driverId} did NOT accept ride ${ride.rideId} in time`
          );
          io.to(driver.driverId).emit("rideTimeout", { rideId: ride.rideId });
        }, 10000);

        rideTimers[ride.rideId].push(timer);
      }
    });
  });

  // Accept ride
  socket.on("acceptRide", ({ rideId, driverId, driverLocation }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "requested") return;

    // Clear all timers for this ride
    if (rideTimers[rideId]) {
      rideTimers[rideId].forEach((t) => clearTimeout(t));
      delete rideTimers[rideId];
    }

    ride.driverId = driverId;
    ride.status = "accepted";
    if (driverLocation)
      ride.driverLocation = {
        lat: driverLocation.lat,
        lng: driverLocation.lng,
      };

    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    io.to(driverId).emit(`ride_${ride.rideId}`, ride);
    console.log(`✅ Ride ${rideId} accepted by driver ${driverId}`);
  });

  // Driver arrived
  socket.on("driverArrived", ({ rideId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "accepted") return;
    ride.status = "driverArrived";

    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
    console.log(`📍 Driver arrived for ride ${rideId}`);
  });

  // Start ride
  socket.on("startRide", ({ rideId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "driverArrived") return;
    ride.status = "inProgress";

    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
    console.log(`🏁 Ride started ${rideId}`);
  });

  // ✅ Complete one destination
  socket.on("completeDestination", ({ rideId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "inProgress") return;

    const idx = ride.currentIndex ?? 0;

    if (ride.destinations && ride.destinations[idx]) {
      ride.destinations[idx].status = "completed";
    }

    // Move to next destination if available
    if (ride.destinations && idx < ride.destinations.length - 1) {
      ride.currentIndex = idx + 1;
      console.log(`🎯 Completed destination #${idx + 1} for ride ${rideId}`);
    } else {
      ride.status = "completed";
      console.log(`🎉 All destinations completed for ride ${rideId}`);
    }

    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
  });

  // Cancel ride
  socket.on("cancelRide", ({ rideId, userId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status === "completed") return;

    ride.status = "cancelled";

    if (ride.driverId) io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    io.to(userId).emit(`ride_${ride.rideId}`, ride);

    if (rideTimers[rideId]) {
      rideTimers[rideId].forEach((t) => clearTimeout(t));
      delete rideTimers[rideId];
    }

    console.log(`❌ Ride ${rideId} cancelled by user ${userId}`);
  });

  // Update driver location
  socket.on("updateLocation", ({ rideId, lat, lng }) => {
    const ride = rides[rideId];
    if (!ride) return;

    ride.driverLocation = { lat, lng };
    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
  });

  // Sync ride manually
  socket.on("syncRide", ({ driverId }) => {
    const ride = Object.values(rides).find(
      (r) =>
        r.driverId === driverId &&
        ["accepted", "driverArrived", "inProgress"].includes(r.status!)
    );
    if (ride) {
      socket.emit(`ride_${ride.rideId}`, ride);
    } else {
      socket.emit("noActiveRide");
    }
  });
});

// ---------------- Server Start ----------------

const PORT = 3000;
const HOST = "192.168.0.152";
// const HOST = "192.168.100.203";

httpServer.listen(PORT, HOST, () => {
  console.log(`🚕 Socket server running at http://${HOST}:${PORT}`);
});
