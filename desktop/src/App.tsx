import { useEffect } from "react";
import { useHubStore } from "./hub/store";
import { HubConfigScreen } from "./screens/HubConfigScreen";
import { HubDrawer } from "./screens/HubDrawer";
import { SessionListScreen } from "./screens/SessionListScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import "./App.css";

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

  return (
    <div className="app">
      {store.connectError && (
        <div className="error-banner">
          <span>{store.connectError}</span>
          <button className="tiny secondary" onClick={clearError}>
            ✕
          </button>
        </div>
      )}
      <div className="toolbar">
        <button className="secondary menu-btn" onClick={store.toggleDrawer}>
          ☰
        </button>
        <h1>Agent Hub</h1>
        <span className="subtitle">{store.agentStatus}</span>
        {store.screen !== "connect" && (
          <>
            <button
              className={store.screen === "sessions" ? "active" : "secondary"}
              onClick={() => useHubStore.setState({ screen: "sessions" })}
            >
              会话
            </button>
            <button
              className={store.screen === "settings" ? "active" : "secondary"}
              onClick={() => useHubStore.setState({ screen: "settings" })}
            >
              设置
            </button>
          </>
        )}
      </div>
      <HubDrawer />
      <div key={store.screen} className="screen">
        {store.screen === "connect" && <HubConfigScreen />}
        {store.screen === "sessions" && <SessionListScreen />}
        {(store.screen === "chat" || store.screen === "room") && <ChatScreen />}
        {store.screen === "settings" && <SettingsScreen />}
      </div>
    </div>
  );
}

export default App;
