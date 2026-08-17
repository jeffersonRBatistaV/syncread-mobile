import { StatusBar } from 'expo-status-bar';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Image,
  BackHandler,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import READER_HTML from './readerHtml';

// URL del servidor SyncRead (HTTPS con Let's Encrypt vía sslip.io)
const SERVER_URL = 'https://syncread.207.244.232.191.sslip.io';
const BOOKS_DIR = (FileSystem.documentDirectory || '') + 'books/';
const METADATA_KEY = 'syncread_offline_books';

async function ensureDir() {
  try {
    const info = await FileSystem.getInfoAsync(BOOKS_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });
  } catch {}
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  useKeepAwake();
  const safeInsets = useSafeAreaInsets();
  const [isConnected, setIsConnected] = useState(true);
  const [offlineBooks, setOfflineBooks] = useState([]);
  const [readingBook, setReadingBook] = useState(null); // { id, title, epubBase64 }
  const [offlineSearch, setOfflineSearch] = useState('');
  const webviewRef = useRef(null);
  const isConnectedRef = useRef(true);

  // Health check real al servidor: si no responde en 3s → OFFLINE.
  // Promise.race es más confiable que AbortController en React Native.
  const checkServer = useCallback(async () => {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
      const ping = fetch(`${SERVER_URL}/api/health`, { headers: { 'Cache-Control': 'no-cache' } });
      const res = await Promise.race([ping, timeout]);
      const ok = res.ok;
      if (ok !== isConnectedRef.current) {
        isConnectedRef.current = ok;
        setIsConnected(ok);
      }
      return ok;
    } catch {
      if (isConnectedRef.current) {
        isConnectedRef.current = false;
        setIsConnected(false);
      }
      return false;
    }
  }, []);

  // Detectar conectividad: NetInfo da avisos rápidos, pero la verdad la dice
  // el health check (NetInfo solo sabe si hay red local, no internet real).
  useEffect(() => {
    let cancelled = false;
    const unsub = NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false && state.isInternetReachable !== false;
      if (connected) {
        // Hay red local — confirmar con health check antes de mostrar el WebView
        checkServer();
      } else if (isConnectedRef.current) {
        isConnectedRef.current = false;
        setIsConnected(false);
      }
    });
    // Primer chequeo al montar
    checkServer();
    // Re-chequear cada 8s (si el WebView se queda cargando, se detecta y pasa a offline)
    const interval = setInterval(() => {
      if (!cancelled) checkServer();
    }, 8000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(interval);
    };
  }, [checkServer]);

  // Botón de retroceso de Android: navegar hacia atrás en lugar de cerrar la app
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // 1. Si el lector offline está abierto → volver a la biblioteca
      if (readingBook) {
        setReadingBook(null);
        return true;
      }
      // 2. Si el WebView tiene historia → retroceder dentro de la app
      try {
        if (webviewRef.current) {
          const canBack =
            typeof webviewRef.current.canGoBack === 'function'
              ? webviewRef.current.canGoBack()
              : webviewRef.current.canGoBack === true;
          if (canBack) {
            webviewRef.current.goBack();
            return true;
          }
        }
      } catch {}
      // 3. En la raíz → permitir que el sistema cierre la app
      return false;
    });
    return () => sub.remove();
  }, [readingBook]);

  // Cargar libros guardados en filesystem
  const loadOfflineBooks = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(METADATA_KEY);
      setOfflineBooks(raw ? JSON.parse(raw) : []);
    } catch {
      setOfflineBooks([]);
    }
  }, []);

  useEffect(() => {
    ensureDir();
    loadOfflineBooks();
  }, [loadOfflineBooks]);

  // Guardar EPUB que llega desde la web (postMessage del WebView).
  // La web SOLO avisa "descarga el libro X" — la app descarga el EPUB
  // directamente del servidor (fetch nativo), evitando el límite del bridge
  // postMessage que trunca el base64 grande en Android.
  const handleMessage = useCallback(
    async (event) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        if (msg.type === 'download') {
          await ensureDir();
          const filePath = `${BOOKS_DIR}${msg.bookId}.epub`;
          try {
            // Descargar el EPUB desde el servidor con el token de la sesión
            const res = await fetch(`${SERVER_URL}/api/books/${msg.bookId}/file`, {
              headers: { Authorization: `Bearer ${msg.token}` },
            });
            if (!res.ok) return;
            const buf = await res.arrayBuffer();
            const b64 = await new Promise((resolve, reject) => {
              try {
                const bytes = new Uint8Array(buf);
                let bin = '';
                const CHUNK = 0x8000;
                for (let i = 0; i < bytes.length; i += CHUNK) {
                  bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                }
                resolve(btoa(bin));
              } catch (e) { reject(e); }
            });
            await FileSystem.writeAsStringAsync(filePath, b64, {
              encoding: FileSystem.EncodingType.Base64,
            });
          } catch { return; }
          // Actualizar metadata local (título/portada desde la web)
          const raw = await AsyncStorage.getItem(METADATA_KEY);
          const list = raw ? JSON.parse(raw) : [];
          const existing = list.filter((b) => b.id !== msg.bookId);
          existing.push({ id: msg.bookId, title: msg.title, author: msg.author, coverPath: msg.coverPath });
          await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(existing));
          setOfflineBooks(existing);
        } else if (msg.type === 'delete') {
          // El libro se eliminó desde la web — borrar copia local también
          try {
            await FileSystem.deleteAsync(`${BOOKS_DIR}${msg.bookId}.epub`, { idempotent: true });
            await FileSystem.deleteAsync(`${BOOKS_DIR}reader_${msg.bookId}.html`, { idempotent: true });
          } catch {}
          const raw = await AsyncStorage.getItem(METADATA_KEY);
          const list = raw ? JSON.parse(raw) : [];
          await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(list.filter((b) => b.id !== msg.bookId)));
          setOfflineBooks(list.filter((b) => b.id !== msg.bookId));
        } else if (msg.type === 'update-meta') {
          // Metadata editada desde la web — actualizar copia local
          const raw = await AsyncStorage.getItem(METADATA_KEY);
          const list = raw ? JSON.parse(raw) : [];
          const updated = list.map((b) =>
            String(b.id) === String(msg.bookId)
              ? { ...b, title: msg.title, author: msg.author || '' }
              : b
          );
          await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(updated));
          setOfflineBooks(updated);
        } else if (msg.type === 'close') {
          setReadingBook(null);
        }
      } catch {}
    },
    []
  );

  const openOfflineBook = async (book) => {
    try {
      // Registrar la lectura (para ordenar "recientemente leídos" primero)
      try {
        const raw = await AsyncStorage.getItem(METADATA_KEY);
        const list = raw ? JSON.parse(raw) : [];
        const updated = list.map((b) =>
          String(b.id) === String(book.id) ? { ...b, lastReadAt: Date.now() } : b
        );
        await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(updated));
        setOfflineBooks(updated);
      } catch {}
      const filePath = `${BOOKS_DIR}${book.id}.epub`;
      const info = await FileSystem.getInfoAsync(filePath);
      if (!info.exists) return;
      const b64 = await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Escribir el HTML completo (lector + EPUB base64) a un archivo y cargarlo
      // vía file:// — source={{ html }} de react-native-webview trunca datos
      // grandes (~1MB) en Android y el libro no abre.
      // Inyectar los safe-areas REALES del dispositivo (env() no funciona en file://):
      // la app nativa conoce los insets exactos de la barra de estado y navegación.
      let htmlWithEpub = READER_HTML
        .replace('__EPUB_BASE64_PLACEHOLDER__', b64)
        .replace('env(safe-area-inset-top, 0px)', `${safeInsets.top}px`)
        .replace('env(safe-area-inset-bottom, 0px)', `${safeInsets.bottom}px`);
      const htmlPath = `${BOOKS_DIR}reader_${book.id}.html`;
      await FileSystem.writeAsStringAsync(htmlPath, htmlWithEpub, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      setReadingBook({ id: book.id, title: book.title, htmlPath });
    } catch {}
  };

  const removeOfflineBook = async (book) => {
    try {
      await FileSystem.deleteAsync(`${BOOKS_DIR}${book.id}.epub`, { idempotent: true });
      await FileSystem.deleteAsync(`${BOOKS_DIR}reader_${book.id}.html`, { idempotent: true });
      const raw = await AsyncStorage.getItem(METADATA_KEY);
      const list = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(list.filter((b) => b.id !== book.id)));
      setOfflineBooks(list.filter((b) => b.id !== book.id));
    } catch {}
  };

  // MODO LECTOR OFFLINE: WebView cargando el HTML (con EPUB embebido) desde file://
  if (readingBook) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <WebView
          originWhitelist={['*']}
          source={{ uri: readingBook.htmlPath }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          onMessage={(e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data);
              if (msg.type === 'close') setReadingBook(null);
            } catch {}
          }}
        />
      </View>
    );
  }

  // MODO OFFLINE: biblioteca nativa con libros descargados
  if (!isConnected) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        <View style={styles.offlineHeader}>
          <Text style={styles.offlineTitle}>Sin conexión</Text>
          <Text style={styles.offlineSubtitle}>
            {offlineBooks.length
              ? `${offlineBooks.length} libro(s) disponible(s)`
              : 'Descarga libros estando conectado'}
          </Text>
        </View>
        {offlineBooks.length > 0 && (
          <View style={styles.searchWrap}>
            <TextInput
              value={offlineSearch}
              onChangeText={setOfflineSearch}
              placeholder="Buscar libro o autor…"
              placeholderTextColor="#8A8A93"
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        )}
        {offlineBooks.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No hay libros descargados</Text>
            <Text style={styles.emptySub}>Conéctate, abre un libro y toca "Descargar"</Text>
          </View>
        ) : (
          <FlatList
            data={[...offlineBooks]
              // Ordenar: recientemente leídos primero (los nunca leídos al final)
              .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
              .filter((item) => {
              if (!offlineSearch.trim()) return true;
              const q = offlineSearch.trim().toLowerCase();
              return (
                (item.title || '').toLowerCase().includes(q) ||
                (item.author || '').toLowerCase().includes(q)
              );
            })}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>Sin resultados para "{offlineSearch}"</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={styles.bookRow}>
                <TouchableOpacity style={styles.bookInfo} onPress={() => openOfflineBook(item)}>
                  <View style={styles.bookCover}>
                    <Text style={styles.bookCoverText}>
                      {(item.title || '?').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.bookTextWrap}>
                    <Text style={styles.bookTitle} numberOfLines={1}>{item.title}</Text>
                    {item.author ? (
                      <Text style={styles.bookAuthor} numberOfLines={1}>{item.author}</Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
                <TouchableOpacity style={styles.deleteBtn} onPress={() => removeOfflineBook(item)}>
                  <Text style={styles.deleteText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        )}
      </SafeAreaView>
    );
  }

  // MODO ONLINE: WebView normal al servidor (la web maneja sus propios safe-areas con env())
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <WebView
        ref={webviewRef}
        source={{ uri: SERVER_URL }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        renderLoading={() => (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#5E6AD2" />
            <Text style={styles.loadingText}>Conectando…</Text>
          </View>
        )}
        onMessage={handleMessage}
        onLoadEnd={() => {
          // Inyectar la lista REAL de libros descargados en el filesystem de la
          // app — la fuente de verdad. Así la web marca correctamente el estado
          // "Descargado" aunque se haya borrado offline desde la biblioteca nativa.
          try {
            const ids = offlineBooks.map((b) => b.id);
            webviewRef.current?.injectJavaScript(
              `window.__syncread_offline_ids = ${JSON.stringify(ids)}; window.dispatchEvent(new Event('syncread-offline-sync')); true;`
            );
          } catch {}
        }}
        onError={() => {
          // La web no cargó — pasar a modo offline nativo (biblioteca local)
          isConnectedRef.current = false;
          setIsConnected(false);
        }}
        onHttpError={() => {
          isConnectedRef.current = false;
          setIsConnected(false);
        }}
      />
    </View>
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
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A0A0A',
    gap: 12,
  },
  loadingText: {
    color: '#8A8A93',
    fontSize: 13,
  },
  offlineHeader: {
    paddingTop: 16,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F1F23',
  },
  offlineTitle: {
    color: '#EDEDED',
    fontSize: 20,
    fontWeight: '600',
  },
  offlineSubtitle: {
    color: '#8A8A93',
    fontSize: 13,
    marginTop: 2,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyText: {
    color: '#EDEDED',
    fontSize: 15,
  },
  emptySub: {
    color: '#8A8A93',
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
  listContent: {
    padding: 16,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  searchInput: {
    backgroundColor: '#131316',
    borderWidth: 1,
    borderColor: '#1F1F23',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#EDEDED',
    fontSize: 14,
  },
  bookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#131316',
    borderWidth: 1,
    borderColor: '#1F1F23',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  bookInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  bookCover: {
    width: 42,
    height: 56,
    borderRadius: 6,
    backgroundColor: '#1F1F23',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  bookCoverText: {
    color: '#8A8A93',
    fontSize: 18,
    fontWeight: '600',
  },
  bookTextWrap: {
    flex: 1,
  },
  bookTitle: {
    color: '#EDEDED',
    fontSize: 14,
    fontWeight: '500',
  },
  bookAuthor: {
    color: '#8A8A93',
    fontSize: 12,
    marginTop: 2,
  },
  deleteBtn: {
    padding: 8,
  },
  deleteText: {
    color: '#8A8A93',
    fontSize: 16,
  },
});
