// backend.ts
import { Server } from "socket.io";
import http from "http";

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

interface Location {
  lat: number;
  lng: number;
  address?: string; // <-- new optional field for human-readable address
}

interface Ride {
  rideId: string;
  userId: string;
  driverId?: string;
  status?: string;
  driverLocation?: Location;
  pickupLocation?: Location;
  destination?: Location;
  createdAt?: number;
}

interface Driver {
  driverId: string;
  socketId: string;
  online: boolean;
}

// Keep track of drivers
const drivers: Record<string, Driver> = {};
const rides: Record<string, Ride> = {};

io.on("connection", (socket) => {
  console.log("🔗 Client connected:", socket.id);

  // Driver registers
  socket.on("registerDriver", ({ driverId }) => {
    console.log("📝 Driver registered:", driverId);
    drivers[driverId] = { driverId, socketId: socket.id, online: true };
    socket.join(driverId);

    io.emit("driverStatusChanged", { driverId, online: true });

    // 🟢 Auto-sync any ongoing ride
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

  // User registers
  socket.on("registerUser", ({ userId }) => {
    socket.join(userId);
    console.log("📝 User registered:", userId);

    // 🟢 Auto-sync any ongoing ride
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
        `🔄 Auto-synced user ride ${activeRide.rideId} for user ${userId} : ${activeRide.status}`
      );
    }
  });

  // Driver goes offline manually
  socket.on("driverOffline", ({ driverId }) => {
    const driver = drivers[driverId];
    if (driver) {
      driver.online = false;
      io.emit("driverStatusChanged", { driverId, online: false });
      console.log(`🛑 Driver ${driverId} went offline`);
    }
  });

  // Driver goes online manually (if needed after disconnect)
  socket.on("driverOnline", ({ driverId }) => {
    const driver = drivers[driverId];
    if (driver) {
      driver.online = true;
      io.emit("driverStatusChanged", { driverId, online: true });
      console.log(`✅ Driver ${driverId} is online`);
    }
  });

  // Update existing disconnect logic
  socket.on("disconnect", () => {
    // Mark driver offline if disconnected
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

  // Keep track of ride timers
  const rideTimers: Record<string, NodeJS.Timeout[]> = {};

  // Ride requested
  socket.on("rideRequested", (ride) => {
    ride.status = "requested";
    ride.createdAt = Math.floor(Date.now() / 1000);
    rides[ride.rideId] = ride;

    rideTimers[ride.rideId] = [];

    // Send to all drivers who are online and free
    Object.values(drivers).forEach((driver) => {
      const driverIsOnline = driver.online;
      const driverIsFree = !Object.values(rides).some(
        (r) =>
          r.driverId === driver.driverId &&
          ["accepted", "driverArrived", "inProgress"].includes(r.status!)
      );

      if (driverIsOnline && driverIsFree) {
        // Emit ride request
        io.to(driver.driverId).emit("rideRequested", ride);
        console.log(`📤 Ride ${ride.rideId} sent to driver ${driver.driverId}`);

        // Start 10-second timer for this driver
        const timer = setTimeout(() => {
          console.log(
            `⏱ Driver ${driver.driverId} did NOT accept ride ${ride.rideId} in time`
          );
          io.to(driver.driverId).emit("rideTimeout", { rideId: ride.rideId });
        }, 10000000);

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

    // Assign driver
    ride.driverId = driverId;
    ride.status = "accepted";
    if (driverLocation) {
      ride.driverLocation = {
        lat: driverLocation.lat,
        lng: driverLocation.lng,
      };
    }

    // Emit to user and driver
    if (ride.userId) io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    io.to(driverId).emit(`ride_${ride.rideId}`, ride);
    console.log(`✅ Ride ${rideId} accepted by driver ${driverId}`);
  });

  // Driver arrived
  socket.on("driverArrived", ({ rideId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "accepted") return;
    ride.status = "driverArrived";
    if (ride.driverId != null)
      io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    console.log(`📍 Driver arrived for ride ${rideId}`);
  });

  // Start ride
  socket.on("startRide", ({ rideId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "driverArrived") return;
    ride.status = "inProgress";
    if (ride.driverId != null)
      io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    console.log(`🏁 Ride started ${rideId}`);
  });

  // Complete ride
  socket.on("completeRide", ({ rideId }) => {
    const ride = rides[rideId];
    if (!ride || ride.status !== "inProgress") return;
    ride.status = "completed";
    if (ride.driverId != null)
      io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    console.log(`🎉 Ride completed ${rideId}`);
  });

  // User cancels ride
  socket.on("cancelRide", ({ rideId, userId }) => {
    const ride = rides[rideId];
    if (!ride) return;

    // Only allow cancellation if ride is not completed
    if (ride.status === "completed") return;

    ride.status = "cancelled";

    // Notify driver if assigned
    if (ride.driverId) {
      io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    }

    // Notify user
    io.to(userId).emit(`ride_${ride.rideId}`, ride);

    // Clear any pending timers
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
    if (ride.driverId != null)
      io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
    console.log(
      `📍 Driver location updated for ride ${rideId}: (${lat},${lng})`
    );
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });

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

const PORT = 3000;
const HOST = "192.168.100.203"; // your local Wi-Fi IP

httpServer.listen(PORT, HOST, () => {
  console.log(`🚕 Socket server running at http://${HOST}:${PORT}`);
});
