(() => {
  'use strict';

  const DB_NAME = 'zhiying-project-library';
  const ACTIVE_KEY = 'activeProjectId';
  let database = null;
  let opening = null;

  function storeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function open() {
    if (database) return Promise.resolve();
    if (opening) return opening.promise;

    const attempt = { promise: null, settled: false };
    opening = attempt;
    attempt.promise = new Promise((resolve, reject) => {
      const fail = (error) => {
        if (attempt.settled) return;
        attempt.settled = true;
        if (opening === attempt) opening = null;
        reject(error);
      };

      let request;
      try {
        request = window.indexedDB.open(DB_NAME, 1);
      } catch (error) {
        fail(error);
        return;
      }

      request.onblocked = () => {
        fail(storeError('blocked', 'The project library is blocked by another connection.'));
      };
      request.onerror = () => {
        fail(request.error || new Error('Unable to open the project library.'));
      };
      request.onupgradeneeded = () => {
        if (attempt.settled) {
          request.transaction.abort();
          return;
        }
        try {
          const connection = request.result;
          if (!connection.objectStoreNames.contains('projects')) {
            connection.createObjectStore('projects', { keyPath: 'id' });
          }
          if (!connection.objectStoreNames.contains('meta')) {
            connection.createObjectStore('meta', { keyPath: 'key' });
          }
          if (!connection.objectStoreNames.contains('assets')) {
            connection.createObjectStore('assets', { keyPath: 'id' });
          }
        } catch (error) {
          fail(error);
          request.transaction.abort();
        }
      };
      request.onsuccess = () => {
        const connection = request.result;
        if (attempt.settled || opening !== attempt) {
          connection.close();
          return;
        }
        const clearConnection = () => {
          if (database === connection) database = null;
        };
        connection.onversionchange = () => {
          clearConnection();
          connection.close();
        };
        connection.onclose = clearConnection;
        database = connection;
        opening = null;
        attempt.settled = true;
        resolve();
      };
    });
    return attempt.promise;
  }

  async function transact(storeNames, mode, work) {
    while (!database) await open();
    const connection = database;
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = connection.transaction(storeNames, mode);
      } catch (error) {
        if (error.name === 'InvalidStateError' && database === connection) {
          database = null;
          connection.close();
        }
        reject(error);
        return;
      }

      let result;
      let failure;
      const abort = (error) => {
        if (!failure) failure = error;
        try {
          transaction.abort();
        } catch {
          reject(failure);
        }
      };
      const onSuccess = (request, callback) => {
        request.onsuccess = () => {
          try {
            callback(request.result);
          } catch (error) {
            abort(error);
          }
        };
      };
      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else resolve(result);
      };
      transaction.onabort = () => {
        reject(failure || transaction.error || new Error('The project library transaction was aborted.'));
      };
      transaction.onerror = (event) => {
        abort(event.target.error || transaction.error || new Error('The project library transaction failed.'));
      };

      try {
        work(transaction, (value) => { result = value; }, onSuccess);
      } catch (error) {
        abort(error);
      }
    });
  }

  function list() {
    return transact(['projects'], 'readonly', (transaction, setResult, onSuccess) => {
      onSuccess(transaction.objectStore('projects').getAll(), (records) => {
        setResult(records.sort((a, b) => b.updatedAt - a.updatedAt));
      });
    });
  }

  function get(id) {
    return transact(['projects'], 'readonly', (transaction, setResult, onSuccess) => {
      onSuccess(transaction.objectStore('projects').get(id), setResult);
    });
  }

  function getActive() {
    return transact(['meta', 'projects'], 'readonly', (transaction, setResult, onSuccess) => {
      onSuccess(transaction.objectStore('meta').get(ACTIVE_KEY), (active) => {
        if (active) {
          onSuccess(transaction.objectStore('projects').get(active.value), setResult);
        }
      });
    });
  }

  function activate(id) {
    return transact(['projects', 'meta'], 'readwrite', (transaction, setResult, onSuccess) => {
      onSuccess(transaction.objectStore('projects').get(id), (record) => {
        if (!record) throw storeError('missing', 'The project does not exist.');
        transaction.objectStore('meta').put({ key: ACTIVE_KEY, value: id });
      });
    });
  }

  async function create(draft, { assets = [], activate: shouldActivate = false } = {}) {
    const now = Date.now();
    const record = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      draft: structuredClone(draft)
    };
    const images = assets.map(({ id, blob }) => ({ id, blob }));
    return transact(['projects', 'assets', 'meta'], 'readwrite', (transaction, setResult) => {
      transaction.objectStore('projects').add(record);
      const assetStore = transaction.objectStore('assets');
      for (const asset of images) assetStore.put(asset);
      if (shouldActivate) {
        transaction.objectStore('meta').put({ key: ACTIVE_KEY, value: record.id });
      }
      setResult(record);
    });
  }

  async function save(id, draft, expectedRevision) {
    const snapshot = structuredClone(draft);
    return transact(['projects'], 'readwrite', (transaction, setResult, onSuccess) => {
      const projects = transaction.objectStore('projects');
      onSuccess(projects.get(id), (record) => {
        if (!record) throw storeError('missing', 'The project does not exist.');
        if (record.revision !== expectedRevision) {
          throw storeError('conflict', 'The project was changed by another writer.');
        }
        const updated = {
          ...record,
          updatedAt: Date.now(),
          revision: record.revision + 1,
          draft: snapshot
        };
        projects.put(updated);
        setResult(updated);
      });
    });
  }

  function remove(id) {
    return transact(['projects', 'meta', 'assets'], 'readwrite', (transaction, setResult, onSuccess) => {
      const projects = transaction.objectStore('projects');
      const meta = transaction.objectStore('meta');
      onSuccess(projects.get(id), (removed) => {
        if (!removed) return;
        const candidates = new Set(removed.draft.scenes.map(scene => scene.visual?.imageId).filter(Boolean));
        projects.delete(id);
        onSuccess(meta.get(ACTIVE_KEY), (active) => {
          if (active && active.value === id) meta.delete(ACTIVE_KEY);
        });
        onSuccess(projects.getAll(), (records) => {
          for (const record of records) {
            for (const scene of record.draft.scenes) candidates.delete(scene.visual?.imageId);
          }
          const assets = transaction.objectStore('assets');
          candidates.forEach(imageId => assets.delete(imageId));
        });
      });
    });
  }

  function putAsset(id, blob) {
    return transact(['assets'], 'readwrite', (transaction) => {
      transaction.objectStore('assets').put({ id, blob });
    });
  }

  function getAsset(id) {
    return transact(['assets'], 'readonly', (transaction, setResult, onSuccess) => {
      onSuccess(transaction.objectStore('assets').get(id), (asset) => {
        setResult(asset?.blob);
      });
    });
  }

  window.ProjectStore = { open, list, get, getActive, activate, create, save, remove, putAsset, getAsset };
})();
