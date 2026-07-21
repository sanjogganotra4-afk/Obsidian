import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// No StrictMode: double-invoked effects would double-start Tone.js transport
// and WebGL init on some devices.
createRoot(document.getElementById('root')).render(<App />)
