import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MantineProvider } from "@mantine/core"
import "@mantine/core/styles.css"
import App from "./App.tsx"
import "./style.css"

const root = document.getElementById("root")
if (!root) throw new Error("Missing root element")

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="light" theme={{ primaryColor: "dark", defaultRadius: "sm" }}>
      <App />
    </MantineProvider>
  </StrictMode>,
)
