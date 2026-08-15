import { StatusBar } from 'expo-status-bar';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Image,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

// URL del servidor SyncRead (cambiar a syncread.resuelveya.com cuando el DNS funcione)
const SERVER_URL = 'http://207.244.232.191';
const BOOKS_DIR = FileSystem.documentDirectory + 'books/';
const METADATA_KEY = 'syncread_offline_books';
const READER_HTML = require('./assets/reader-offline.html');

async function ensureDir() {
  try {
    const info = await FileSystem.getInfoAsync(BOOKS_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });
  } catch {}
}

export default function App() {
  useKeepAwake();
  const [isConnected, setIsConnected] = useState(true);
  const [offlineBooks, setOfflineBooks] = useState([]);
  const [readingBook, setReadingBook] = useState(null); // { id, title, epubBase64 }
  const webviewRef = useRef(null);
  const isConnectedRef = useRef(true);

  // Detectar conectividad
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false;
      isConnectedRef.current = connected;
      setIsConnected(connected);
    });
    return unsub;
  }, []);

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

  // Guardar EPUB que llega desde la web (postMessage del WebView)
  const handleMessage = useCallback(
    async (event) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        if (msg.type === 'download' && msg.epubBase64) {
          await ensureDir();
          const filePath = `${BOOKS_DIR}${msg.bookId}.epub`;
          await FileSystem.writeAsStringAsync(filePath, msg.epubBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          // Actualizar metadata local
          const raw = await AsyncStorage.getItem(METADATA_KEY);
          const list = raw ? JSON.parse(raw) : [];
          const existing = list.filter((b) => b.id !== msg.bookId);
          existing.push({ id: msg.bookId, title: msg.title, author: msg.author, coverPath: msg.coverPath });
          await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(existing));
          setOfflineBooks(existing);
        } else if (msg.type === 'close') {
          setReadingBook(null);
        }
      } catch {}
    },
    []
  );

  const openOfflineBook = async (book) => {
    try {
      const filePath = `${BOOKS_DIR}${book.id}.epub`;
      const info = await FileSystem.getInfoAsync(filePath);
      if (!info.exists) return;
      const b64 = await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      setReadingBook({ id: book.id, title: book.title, epubBase64: b64 });
    } catch {}
  };

  const removeOfflineBook = async (book) => {
    try {
      await FileSystem.deleteAsync(`${BOOKS_DIR}${book.id}.epub`, { idempotent: true });
      const raw = await AsyncStorage.getItem(METADATA_KEY);
      const list = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(METADATA_KEY, JSON.stringify(list.filter((b) => b.id !== book.id)));
      setOfflineBooks(list.filter((b) => b.id !== book.id));
    } catch {}
  };

  // MODO LECTOR OFFLINE: WebView con el HTML standalone + EPUB inyectado
  if (readingBook) {
    const htmlWithEpub = READER_HTML.replace('__EPUB_BASE64_PLACEHOLDER__', readingBook.epubBase64);
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <WebView
          originWhitelist={['*']}
          source={{ html: htmlWithEpub, baseUrl: 'file:///android_asset/' }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          onMessage={(e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data);
              if (msg.type === 'close') setReadingBook(null);
            } catch {}
          }}
        />
      </SafeAreaView>
    );
  }

  // MODO OFFLINE: biblioteca nativa con libros descargados
  if (!isConnected) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.offlineHeader}>
          <Text style={styles.offlineTitle}>Sin conexión</Text>
          <Text style={styles.offlineSubtitle}>
            {offlineBooks.length
              ? `${offlineBooks.length} libro(s) disponible(s)`
              : 'Descarga libros estando conectado'}
          </Text>
        </View>
        {offlineBooks.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No hay libros descargados</Text>
            <Text style={styles.emptySub}>Conéctate, abre un libro y toca "Descargar"</Text>
          </View>
        ) : (
          <FlatList
            data={offlineBooks}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={styles.listContent}
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

  // MODO ONLINE: WebView normal al servidor
  return (
    <SafeAreaView style={styles.container}>
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
        onMessage={handleMessage}
        onError={() => {
          // Si la web no carga, intentar modo offline
          if (!isConnectedRef.current) setIsConnected(false);
        }}
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
