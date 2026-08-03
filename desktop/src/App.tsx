import { useEffect } from "react";
import { useHubStore } from "./hub/store";
import { ConnectScreen } from "./screens/ConnectScreen";
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

  return (
    <div className="app">
      <div className="toolbar">
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
            <button className="danger" onClick={store.disconnect}>
              断开
            </button>
          </>
        )}
      </div>
      <div className="screen">
        {store.screen === "connect" && <ConnectScreen />}
        {store.screen === "sessions" && <SessionListScreen />}
        {(store.screen === "chat" || store.screen === "room") && <ChatScreen />}
        {store.screen === "settings" && <SettingsScreen />}
      </div>
    </div>
  );
}

export default App;
