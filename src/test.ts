// socket.on("ride:status", async (data: {
//   roomToken: string;
//   status: "requested" | "accepted" | "driverArrived" | "inProgress" | "completed" | "cancelled";
//   triggeredBy: "rider" | "driver" | "system"; // Who initiated
//   metadata?: any; // Additional context
//   timestamp?: Date;
// }) => {
//   // Validate roomToken
//   if (!data.roomToken) {
//     console.error("❌ roomToken missing in ride:status");
//     return;
//   }

//   // Validate state transition (optional but recommended)
//   if (!isValidTransition(currentStatus, data.status)) {
//     console.error(`❌ Invalid status transition: ${currentStatus} -> ${data.status}`);
//     return;
//   }

//   // Update Firestore
//   await ridesCollection.doc(data.roomToken).set({
//     status: data.status,
//     lastStatusUpdate: {
//       status: data.status,
//       triggeredBy: data.triggeredBy,
//       metadata: data.metadata,
//       timestamp: admin.firestore.FieldValue.serverTimestamp()
//     },
//     updatedAt: admin.firestore.FieldValue.serverTimestamp()
//   }, { merge: true });

//   // Broadcast to room
//   io.to(data.roomToken).emit("ride:status", {
//     status: data.status,
//     triggeredBy: data.triggeredBy,
//     metadata: data.metadata,
//     timestamp: new Date()
//   });
// });

// // Keep driver:location separate - it's fundamentally different
// socket.on("driver:location", async (data: {
//   roomToken: string;
//   location: { lat: number; lng: number };
// }) => {
//   // High-frequency updates, no state change
//   await ridesCollection.doc(data.roomToken).set({
//     lastDriverLocation: data.location,
//     locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
//   }, { merge: true });

//   io.to(data.roomToken).emit("driver:location", data.location);
// });