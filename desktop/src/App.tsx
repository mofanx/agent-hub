import { useEffect } from "react";
import { X } from "lucide-react";
import { useHubStore } from "./hub/store";
import { HubConfigScreen } from "./screens/HubConfigScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ScheduleScreen } from "./screens/ScheduleScreen";
import { Sidebar } from "./components/Sidebar";

function App() {
  const store = useHubStore();

  useEffect(() => {
    void store.init();
  }, [store.init]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const effective =
      store.themeMode === "dark" || (store.themeMode === "system" && prefersDark) ? "dark" : "light";
    root.dataset.theme = effective;
  }, [store.themeMode]);

  const clearError = () => useHubStore.setState({ connectError: null });

  if (store.screen === "connect") {
    return (
      <div className="app">
        {store.connectError && (
          <div className="error-banner">
            <span>{store.connectError}</span>
            <button className="icon-btn" onClick={clearError}>
              <X size={13} />
            </button>
          </div>
        )}
        <HubConfigScreen />
      </div>
    );
  }

  return (
    <div className="app">
      {store.connectError && (
        <div className="error-banner">
          <span>{store.connectError}</span>
          <button className="icon-btn" onClick={clearError}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="shell">
        <Sidebar />
        <main className="main">
          <div key={store.screen} className="screen">
            {store.screen === "sessions" && <HomeScreen />}
            {(store.screen === "chat" || store.screen === "room") && <ChatScreen />}
            {store.screen === "settings" && <SettingsScreen />}
            {store.screen === "schedule" && <ScheduleScreen />}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
