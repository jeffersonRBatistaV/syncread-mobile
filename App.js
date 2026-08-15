import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';

// URL del servidor SyncRead (cambiar a syncread.resuelveya.com cuando el DNS funcione)
const SERVER_URL = 'http://207.244.232.191';

export default function App() {
  // Mantener la pantalla encendida mientras se lee — nunca se apaga ni se bloquea
  useKeepAwake();

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <WebView
        source={{ uri: SERVER_URL }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
});
