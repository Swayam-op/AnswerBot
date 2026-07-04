import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Dev server config.
// - basicSsl()  -> serves over HTTPS with a self-signed cert. REQUIRED so the
//                  phone camera works: browsers only allow getUserMedia on
//                  localhost or HTTPS. On the phone you must accept the
//                  "not secure" warning once.
// - host: true  -> reachable from your phone on the same Wi-Fi
//                  (https://<PC-IP>:5173)
// - proxy       -> forwards /api calls to the Node backend (server-to-server,
//                  so the backend can stay plain HTTP on localhost).
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
