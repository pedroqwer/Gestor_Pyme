// server.js
const express = require('express');
const cors = require('cors');
const connection = require('./database');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const saltRounds = 10;

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// ---------- FUNCIONES AUXILIARES ----------
function registrarHistorial(jefe_id, accion, descripcion) {
  const query = `INSERT INTO historial (jefe_id, accion, descripcion) VALUES (?, ?, ?)`;
  connection.query(query, [jefe_id, accion, descripcion], (err) => {
    if (err) console.error('Error al guardar historial:', err);
  });
}

function registrarMovimiento(jefe_id, tipo, producto_id, cantidad, observacion = '') {
  if (!jefe_id || !tipo || !producto_id || cantidad == null) {
    console.error('Faltan datos para registrar el movimiento');
    return;
  }

  const query = `
    INSERT INTO movimientos (tipo, producto_id, cantidad, jefe_id, observacion)
    VALUES (?, ?, ?, ?, ?)
  `;

  connection.query(query, [tipo, producto_id, cantidad, jefe_id, observacion], (err, result) => {
    if (err) {
      console.error('❌ Error al registrar movimiento:', err);
      return;
    }

    /*const desc = `${tipo.toUpperCase()} de ${cantidad} unidades del producto ID ${producto_id}` +
                 (observacion ? ` (${observacion})` : '');
    registrarHistorial(jefe_id, `movimiento - ${tipo}`, desc);*/
  });
}
// ---------- RUTAS PRINCIPALES ----------

// Obtener productos por jefe_id
app.get('/productos', (req, res) => {
  const jefeId = req.query.jefe_id;
  if (!jefeId) return res.status(400).json({ error: 'Se requiere el id del jefe' });

  const query = `
    SELECT p.*, i.cantidad, i.en_venta, i.almacen, i.lote
    FROM productos p
    INNER JOIN inventario i ON p.id = i.producto_id
    WHERE p.jefe_id = ? AND i.en_venta = TRUE
  `;

  connection.query(query, [jefeId], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error al obtener productos' });
    res.json(results);
  });
});

// Registrar producto SOLO si el jefe ya tiene entradas de ese producto
app.post('/registrar/producto', (req, res) => {
  const {
    nombre, descripcion, modelo, marca,
    cantidad, precio_compra, precio_venta,
    ubicacion, fecha_ingreso, jefe_id
  } = req.body;

  // Validar campos obligatorios
  if (!nombre || cantidad == null || precio_compra == null || precio_venta == null || !jefe_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

 // Registrar producto
const insertQuery = `
  INSERT INTO productos (nombre, descripcion, modelo, marca, cantidad, precio_compra, precio_venta, ubicacion, jefe_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

  const valores = [nombre, descripcion || null, modelo || null, marca || null, cantidad, precio_compra, precio_venta, ubicacion || null, jefe_id];



  connection.query(insertQuery, valores, (err, result) => {
    if (err) {
      console.error('Error al registrar producto:', err);
      return res.status(500).json({ error: 'Error al registrar producto' });
    }

    // Registrar historial y movimiento
    registrarHistorial(jefe_id, 'crear producto', `Producto ${nombre} registrado por jefe ${jefe_id}`);
    registrarMovimiento(jefe_id, 'entrada', result.insertId, cantidad, 'Producto registrado con stock inicial');

    res.status(201).json({ message: 'Producto registrado correctamente', producto_id: result.insertId });
  });
});

// Registrar inventario
app.post('/registrar/inventario', (req, res) => {
  const { producto_id, almacen, lote, fecha_caducidad, cantidad, en_venta } = req.body;

  if (!producto_id) {
    return res.status(400).json({ error: 'producto_id es obligatorio' });
  }

  const query = `
  INSERT INTO inventario (producto_id, almacen, lote, cantidad, en_venta)
  VALUES (?, ?, ?, ?, ?)
`;

connection.query(query, [producto_id, almacen || 'Principal', lote || null, cantidad || 0, en_venta ? 1 : 0], (err, result) => {
  if (err) return res.status(500).json({ error: 'Error al registrar inventario' });
  res.status(201).json({ mensaje: 'Inventario registrado correctamente' });
});

});


// Registrar entrada
app.post('/entradas/registrar', (req, res) => {
  const {
    producto_id, cantidad, precio_compra,
    proveedor_id, jefe_id
  } = req.body;

  if (!cantidad || !precio_compra || !proveedor_id || !jefe_id) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  connection.beginTransaction(err => {
    if (err) return res.status(500).json({ error: 'Error al iniciar transacción' });

    const insertEntrada = `
      INSERT INTO entradas (producto_id, cantidad, precio_compra, proveedor_id, jefe_id)
      VALUES (?, ?, ?, ?, ?)`;

    connection.query(insertEntrada, [producto_id, cantidad, precio_compra, proveedor_id, jefe_id], (err) => {
      if (err) return connection.rollback(() => res.status(500).json({ error: 'Error al registrar entrada' }));

      const updateProducto = `
        UPDATE productos
        SET cantidad = cantidad + ?, precio_compra = ?
        WHERE id = ?`;

      connection.query(updateProducto, [cantidad, precio_compra, producto_id], (err) => {
        if (err) return connection.rollback(() => res.status(500).json({ error: 'Error al actualizar producto' }));

        const insertMovimiento = `
          INSERT INTO movimientos (tipo, producto_id, cantidad, jefe_id, observacion)
          VALUES ('entrada', ?, ?, ?, 'Entrada por proveedor ID ${proveedor_id}')`;

        connection.query(insertMovimiento, [producto_id, cantidad, jefe_id], (err) => {
          if (err) return connection.rollback(() => res.status(500).json({ error: 'Error al registrar movimiento' }));

          connection.commit(err => {
            if (err) return connection.rollback(() => res.status(500).json({ error: 'Error al confirmar transacción' }));

            registrarHistorial(jefe_id, 'entrada', `Entrada registrada para producto ${producto_id}`);
            registrarMovimiento(jefe_id, 'entrada', producto_id, cantidad, `Entrada por proveedor ID ${proveedor_id}`);
            res.json({ message: 'Entrada registrada correctamente' });
          });
        });
      });
    });
  });
});

// Registrar cliente
app.post('/clientes/registrar', (req, res) => {
  const { nombre, telefono, email, direccion, jefe_id } = req.body;

  if (!nombre || !jefe_id) {
    return res.status(400).json({ error: 'Nombre y jefe_id son requeridos' });
  }

  const query = `
    INSERT INTO clientes (nombre, telefono, email, direccion, jefe_id)
    VALUES (?, ?, ?, ?, ?)`;

  connection.query(query, [nombre, telefono, email, direccion, jefe_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al registrar cliente' });

    registrarHistorial(jefe_id, 'crear cliente', `Cliente ${nombre} registrado`);
    res.status(201).json({ message: 'Cliente registrado correctamente', cliente_id: result.insertId });
  });
});

app.post('/ventas/registrar', (req, res) => {
  const { cliente_id, jefe_id, productos } = req.body;

  // Validar datos
  if (!cliente_id || !jefe_id || !Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'Datos incompletos para la venta' });
  }

  // Calcular total de la venta
  const total = productos.reduce((sum, item) => sum + item.precio * item.cantidad, 0);

  connection.beginTransaction(err => {
    if (err) return res.status(500).json({ error: 'Error al iniciar transacción' });

    // Insertar venta
    connection.query(
      'INSERT INTO ventas (cliente_id, total, jefe_id) VALUES (?, ?, ?)',
      [cliente_id, total, Number(jefe_id)],
      (err, resultVenta) => {
        if (err) {
          return connection.rollback(() =>
            res.status(500).json({ error: 'Error al registrar venta' })
          );
        }

        const ventaId = resultVenta.insertId;

        // Procesar productos
        const tareas = productos.map(producto => {
          return new Promise((resolve, reject) => {
            // Insertar detalle de venta
            connection.query(
              'INSERT INTO detalle_venta (venta_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
              [ventaId, producto.id, producto.cantidad, producto.precio],
              err => {
                if (err) return reject(err);

                // Actualizar stock
                connection.query(
                  'UPDATE productos SET cantidad = cantidad - ? WHERE id = ?',
                  [producto.cantidad, producto.id],
                  err => {
                    if (err) return reject(err);

                    // Registrar movimiento de tipo venta
                    registrarMovimiento(
                      Number(jefe_id),
                      'venta',
                      producto.id,
                      producto.cantidad,
                      `Venta realizada`
                    );

                    resolve();
                  }
                );
              }
            );
          });
        });

        // Ejecutar todas las operaciones
        Promise.all(tareas)
          .then(() => {
            connection.commit(err => {
              if (err) {
                return connection.rollback(() =>
                  res.status(500).json({ error: 'Error al confirmar venta' })
                );
              }

              registrarHistorial(jefe_id, 'venta', `Venta registrada ID ${ventaId}`);
              res.json({ message: 'Venta registrada correctamente', venta_id: ventaId });
            });
          })
          .catch(err => {
            connection.rollback(() =>
              res.status(500).json({ error: 'Error al procesar la venta' })
            );
          });
      }
    );
  });
});



// ---------- LOGIN Y REGISTRO ----------

app.post('/jefe/registro', async (req, res) => {
  const { usuario, contrasena } = req.body;
  if (!usuario || !contrasena) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  try {
    const hashedPassword = await bcrypt.hash(contrasena, saltRounds);
    connection.query(
      'INSERT INTO jefe (usuario, contrasena) VALUES (?, ?)',
      [usuario, hashedPassword],
      (err, result) => {
        if (err) return res.status(500).json({ error: 'Error al registrar usuario' });
        res.status(201).json({ message: 'Usuario registrado', id: result.insertId });
      }
    );
  } catch {
    res.status(500).json({ error: 'Error al procesar contraseña' });
  }
});

app.post('/jefe/login', (req, res) => {
  const { usuario, contrasena } = req.body;
  if (!usuario || !contrasena) return res.status(400).json({ error: 'Campos requeridos' });

  connection.query('SELECT * FROM jefe WHERE usuario = ?', [usuario], async (err, results) => {
    if (err) return res.status(500).json({ error: 'Error al buscar usuario' });

    const jefe = results[0];
    if (!jefe || !(await bcrypt.compare(contrasena, jefe.contrasena))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    res.json({ message: 'Login exitoso', jefe: { id: jefe.id, usuario: jefe.usuario } });
  });
});

app.get('/productos/venta', (req, res) => {
  const jefeId = req.query.jefe_id;
  if (!jefeId) return res.status(400).json({ error: 'Se requiere el id del jefe' });

  const query = `
    SELECT DISTINCT p.id, p.nombre, p.descripcion, p.modelo, p.marca, 
           p.cantidad, p.precio_compra, p.precio_venta, p.ubicacion
    FROM productos p
    INNER JOIN inventario i ON p.id = i.producto_id
    WHERE p.jefe_id = ? AND i.en_venta = 1 AND i.cantidad > 0
  `;

  connection.query(query, [jefeId], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error en la base de datos' });
    if (results.length === 0) return res.status(404).json({ message: 'No se encontraron productos disponibles para vender' });
    res.json(results);
  });
});


 
// Obtener clientes por jefe_id
app.get('/clientes', (req, res) => {
  const jefeId = req.query.jefe_id;

  if (!jefeId) {
    return res.status(400).json({ error: 'Se requiere el id del jefe' });
  }

  const query = 'SELECT * FROM clientes WHERE jefe_id = ?';

  connection.query(query, [jefeId], (err, results) => {
    if (err) {
      console.error('Error al obtener clientes:', err);
      return res.status(500).json({ error: 'Error al obtener clientes' });
    }

    res.json(results);
  });
});

app.put('/productos/actualizar-cantidad', (req, res) => {
  const { producto_id, cantidad, jefe_id } = req.body;

  if (!producto_id || cantidad == null || !jefe_id) {
    return res.status(400).json({ error: 'Datos incompletos para actualizar cantidad' });
  }

  const query = `
    UPDATE productos 
    SET cantidad = ?
    WHERE id = ? AND jefe_id = ?`;

  connection.query(query, [cantidad, producto_id, jefe_id], (err, result) => {
    if (err) {
      console.error('❌ Error al actualizar cantidad:', err);
      return res.status(500).json({ error: 'Error al actualizar cantidad del producto' });
    }

    registrarHistorial(jefe_id, 'editar producto', `Cantidad del producto ID ${producto_id} actualizada a ${cantidad}`);
    res.json({ message: 'Cantidad actualizada correctamente' });
  });
});


// Registrar proveedor
app.post('/proveedores/registrar', (req, res) => {
  const { nombre, contacto, telefono, email, direccion, jefe_id } = req.body;

  // Validación básica
  if (!nombre || !jefe_id) {
    return res.status(400).json({ error: 'Nombre y jefe_id son requeridos' });
  }

  const query = `
    INSERT INTO proveedores (nombre, contacto, telefono, email, direccion, jefe_id)
    VALUES (?, ?, ?, ?, ?, ?)`;

  const values = [nombre, contacto || null, telefono || null, email || null, direccion || null, jefe_id];

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error('❌ Error al registrar proveedor:', err);
      return res.status(500).json({ error: 'Error al registrar proveedor' });
    }

    registrarHistorial(jefe_id, 'crear proveedor', `Proveedor ${nombre} registrado`);
    res.status(201).json({ message: 'Proveedor registrado correctamente', proveedor_id: result.insertId });
  });
});

app.get('/proveedores', (req, res) => {
  const jefeId = req.query.jefe_id; // ✅ leer desde query string
  if (!jefeId) {
    return res.status(400).json({ error: 'Se requiere jefe_id' });
  }

  const sql = 'SELECT * FROM proveedores WHERE jefe_id = ?';
  connection.query(sql, [jefeId], (err, results) => { // ✅ usar la misma conexión
    if (err) {
      console.error('Error al obtener proveedores:', err);
      return res.status(500).json({ error: 'Error en el servidor' });
    }
    res.json(results);
  });
});

// Obtener historial por jefe_id
app.get('/historial', (req, res) => {
  const jefeId = req.query.jefe_id;

  if (!jefeId) {
    return res.status(400).json({ error: 'Se requiere el id del jefe' });
  }

  const query = `
    SELECT 
      id,
      accion,
      descripcion,
      DATE_FORMAT(fecha, '%Y-%m-%d %H:%i:%s') AS fecha
    FROM historial
    WHERE jefe_id = ?
    ORDER BY fecha DESC
  `;

  connection.query(query, [jefeId], (err, results) => {
    if (err) {
      console.error('❌ Error al obtener historial:', err);
      return res.status(500).json({ error: 'Error al obtener historial' });
    }

    res.json(results);
  });
});

app.post('/registrar/entrada', (req, res) => {
  const {
    nombre, descripcion, modelo, marca, precio_venta, ubicacion,
    cantidad, precio_compra, proveedor_id, fecha, jefe_id
  } = req.body;

  // Validación de campos obligatorios
  if (!nombre || cantidad == null || precio_compra == null || !jefe_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const checkProducto = `SELECT id FROM productos WHERE nombre = ? AND jefe_id = ? LIMIT 1`;

  connection.query(checkProducto, [nombre, jefe_id], (err, rows) => {
    if (err) {
      console.log('ERROR SQL al verificar producto:', err);
      return res.status(500).json({ error: 'Error al verificar producto' });
    }

    if (rows.length > 0) {
      const producto_id = rows[0].id;
      registrarEntrada(producto_id);
    } else {
      const insertProducto = `
        INSERT INTO productos 
        (nombre, descripcion, modelo, marca, precio_venta, ubicacion, cantidad, precio_compra, jefe_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      // fecha_ingreso no se inserta en productos, solo se usa para entradas/inventario
      connection.query(insertProducto,
        [nombre, descripcion, modelo, marca, precio_venta, ubicacion, cantidad, precio_compra, jefe_id],
        (err, result) => {
          if (err) {
            console.log('ERROR SQL al registrar producto:', err);
            return res.status(500).json({ error: 'Error al registrar producto' });
          }
          const producto_id = result.insertId;
          registrarEntrada(producto_id, true);
        }
      );
    }
  });

  function registrarEntrada(producto_id, esNuevo = false) {
    const insertEntrada = `
      INSERT INTO entradas (producto_id, cantidad, precio_compra, proveedor_id, fecha, jefe_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const valores = [
      producto_id,
      cantidad,
      precio_compra,
      proveedor_id || null,
      fecha ? fecha.slice(0, 10) : new Date().toISOString().slice(0, 10),
      jefe_id
    ];

    connection.query(insertEntrada, valores, (err, result) => {
      if (err) {
        console.log('ERROR SQL al registrar entrada:', err);
        return res.status(500).json({ error: 'Error al registrar entrada' });
      }

      const updateStock = `UPDATE productos SET cantidad = cantidad + ? WHERE id = ?`;
      connection.query(updateStock, [cantidad, producto_id], (err) => {
        if (err) {
          console.log('ERROR SQL al actualizar stock:', err);
          return res.status(500).json({ error: 'Entrada registrada, pero error al actualizar stock' });
        }

        // Registrar historial y movimiento (asumiendo que tus funciones existen)
        registrarHistorial(jefe_id, 'crear entrada', `Entrada registrada para producto ${producto_id}, cantidad ${cantidad}`);
        registrarMovimiento(jefe_id, 'entrada', producto_id, cantidad, esNuevo ? 'Entrada al registrar nuevo producto' : 'Entrada registrada');

        res.status(201).json({
          message: esNuevo
            ? '✅ Producto creado y entrada registrada correctamente'
            : '✅ Entrada registrada correctamente',
          entrada_id: result.insertId,
          producto_id
        });
      });
    });
  }
});

// Obtener cliente por ID
app.get('/clientes/:id', (req, res) => {
  const { id } = req.params;
  const jefeId = req.query.jefe_id;

  if (!id || !jefeId) {
    return res.status(400).json({ error: 'ID de cliente y jefe_id requeridos' });
  }

  const query = 'SELECT * FROM clientes WHERE id = ? AND jefe_id = ? LIMIT 1';
  connection.query(query, [id, jefeId], (err, results) => {
    if (err) {
      console.error('Error al obtener cliente:', err);
      return res.status(500).json({ error: 'Error al obtener cliente' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json(results[0]);
  });
});

// Obtener historial de compras de un cliente
app.get('/clientes/:id/historial', (req, res) => {
  const { id } = req.params;
  const jefeId = req.query.jefe_id;

  if (!id || !jefeId) {
    return res.status(400).json({ error: 'Cliente ID y jefe_id son requeridos' });
  }

  const query = `
    SELECT 
      v.fecha,
      p.nombre AS producto,
      dv.cantidad,
      (dv.cantidad * dv.precio_unitario) AS total
    FROM ventas v
    JOIN detalle_venta dv ON v.id = dv.venta_id
    JOIN productos p ON dv.producto_id = p.id
    WHERE v.cliente_id = ? AND v.jefe_id = ?
    ORDER BY v.fecha DESC
  `;

  connection.query(query, [id, jefeId], (err, results) => {
    if (err) {
      console.error("❌ Error al obtener historial del cliente:", err);
      return res.status(500).json({ error: 'Error al obtener historial del cliente' });
    }

    res.json(results);
  });
});

// ===============================
// ENDPOINT: Obtener datos de un proveedor
// ===============================
app.get('/proveedores/:id', (req, res) => {
  const proveedorId = req.params.id;
  const jefeId = req.query.jefe_id;

  if (!proveedorId || !jefeId) {
    return res.status(400).json({ error: 'ID del proveedor y jefe_id requeridos' });
  }

  const query = `
    SELECT *
    FROM proveedores
    WHERE id = ? AND jefe_id = ?
  `;

  connection.query(query, [proveedorId, jefeId], (err, results) => {
    if (err) {
      console.error('❌ Error al obtener proveedor:', err);
      return res.status(500).json({ error: 'Error en el servidor' });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }

    res.json(results[0]);
  });
});

// ===============================
// ENDPOINT: Obtener productos de un proveedor
// ===============================
app.get('/proveedores/:id/productos', (req, res) => {
  const proveedorId = req.params.id;
  const jefeId = req.query.jefe_id;

  if (!proveedorId || !jefeId) {
    return res.status(400).json({ error: 'ID del proveedor y jefe_id requeridos' });
  }

  const query = `
    SELECT 
      p.id, 
      p.nombre, 
      p.cantidad, 
      e.precio_compra, 
      DATE_FORMAT(MAX(e.fecha), '%Y-%m-%d') AS ultima_entrada
    FROM entradas e
    JOIN productos p ON e.producto_id = p.id
    WHERE e.proveedor_id = ? AND e.jefe_id = ?
    GROUP BY p.id, p.nombre, p.cantidad, e.precio_compra
    ORDER BY ultima_entrada DESC
  `;

  connection.query(query, [proveedorId, jefeId], (err, results) => {
    if (err) {
      console.error('❌ Error al obtener productos del proveedor:', err);
      return res.status(500).json({ error: 'Error en el servidor' });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'Este proveedor no tiene productos registrados' });
    }

    res.json(results);
  });
});

// Obtener productos más vendidos
app.get('/productos/mas-vendidos', (req, res) => {
  const jefeId = req.query.jefe_id;

  if (!jefeId) {
    return res.status(400).json({ error: 'Se requiere el id del jefe' });
  }

  const query = `
    SELECT 
      p.id,
      p.nombre,
      p.marca,
      SUM(dv.cantidad) AS total_vendido,
      SUM(dv.cantidad * dv.precio_unitario) AS ingresos_totales
    FROM detalle_venta dv
    JOIN productos p ON dv.producto_id = p.id
    JOIN ventas v ON dv.venta_id = v.id
    WHERE v.jefe_id = ?
    GROUP BY p.id, p.nombre, p.marca
    ORDER BY total_vendido DESC
  `;

  connection.query(query, [jefeId], (err, results) => {
    if (err) {
      console.error('❌ Error al obtener productos más vendidos:', err);
      return res.status(500).json({ error: 'Error al obtener productos más vendidos' });
    }

    res.json(results);
  });
});

// Actualizar datos de un cliente
// Actualizar datos de un cliente
app.put('/clientes/:id', (req, res) => {
  const clienteId = req.params.id;
  const jefeId = req.body.jefe_id;
  const { nombre, telefono, email, direccion } = req.body;

  if (!clienteId || !jefeId || !nombre) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const query = `
    UPDATE clientes
    SET nombre = ?, telefono = ?, email = ?, direccion = ?
    WHERE id = ? AND jefe_id = ?
  `;

  connection.query(query, [nombre, telefono, email, direccion, clienteId, jefeId], (err, result) => {
    if (err) {
      console.error('Error al actualizar cliente:', err);
      return res.status(500).json({ error: 'Error al actualizar cliente' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado o no pertenece al jefe' });
    }

    // Registrar historial
    const historialQuery = `INSERT INTO historial (jefe_id, accion, descripcion) VALUES (?, 'editar cliente', ?)`;
    connection.query(historialQuery, [jefeId, `Cliente ${nombre} actualizado`], (err) => {
      if (err) console.error('Error al registrar historial:', err);
    });

    res.json({ message: 'Cliente actualizado correctamente' });
  });
});

// Obtener un producto específico por id y jefe_id
app.get('/productos/:id', (req, res) => {
  const { id } = req.params;
  const jefeId = req.query.jefe_id;

  if (!id || !jefeId) {
    return res.status(400).json({ error: 'Se requiere id del producto y jefe_id' });
  }

  const query = `
    SELECT *
    FROM productos 
    WHERE id = ? AND jefe_id = ? 
    LIMIT 1
  `;

  connection.query(query, [id, jefeId], (err, results) => {
    if (err) {
      console.error('Error al obtener producto:', err);
      return res.status(500).json({ error: 'Error en el servidor' });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(results[0]);
  });
});

app.put('/productos/:id', (req, res) => {
  const productoId = req.params.id;
  const jefeId = req.query.jefe_id; // se manda en la query

  if (!productoId || !jefeId) {
    return res.status(400).json({ error: 'Se requiere id del producto y jefe_id' });
  }

  const campos = req.body;

  if (!campos || Object.keys(campos).length === 0) {
    return res.status(400).json({ error: 'No se recibieron datos para actualizar' });
  }

  // Construir dinámicamente la parte SET del UPDATE
  const columnas = [];
  const valores = [];

  for (const [key, value] of Object.entries(campos)) {
    columnas.push(`${key} = ?`);
    valores.push(value);
  }

  valores.push(productoId, jefeId); // para el WHERE

  const query = `
    UPDATE productos
    SET ${columnas.join(', ')}
    WHERE id = ? AND jefe_id = ?
  `;

  connection.query(query, valores, (err, result) => {
    if (err) {
      console.error('❌ Error al actualizar producto:', err);
      return res.status(500).json({ error: 'Error al actualizar producto' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Producto no encontrado o no pertenece al jefe' });
    }

    registrarHistorial(jefeId, 'editar producto', `Producto ID ${productoId} actualizado`);
    res.json({ message: '✅ Producto actualizado correctamente' });
  });
});


app.delete('/productos/:id', (req, res) => {
  const productoId = req.params.id;
  const jefeId = req.query.jefe_id;

  if (!productoId || !jefeId) {
    return res.status(400).json({ error: 'Se requiere id del producto y jefe_id' });
  }

  // Primero eliminar referencias en tablas hijas
  const queries = [
    'DELETE FROM detalle_venta WHERE producto_id = ?',
    'DELETE FROM movimientos WHERE producto_id = ? AND jefe_id = ?',
    'DELETE FROM salidas WHERE producto_id = ? AND jefe_id = ?',
    'DELETE FROM entradas WHERE producto_id = ? AND jefe_id = ?'
  ];

  // Ejecutar secuencialmente
  let promise = Promise.resolve();
  queries.forEach(q => {
    promise = promise.then(() => new Promise((resolve, reject) => {
      connection.query(q, [productoId, jefeId], (err) => {
        if (err) return reject(err);
        resolve();
      });
    }));
  });

  promise.then(() => {
    // Finalmente, eliminar producto
    const query = 'DELETE FROM productos WHERE id = ? AND jefe_id = ?';
    connection.query(query, [productoId, jefeId], (err, result) => {
      if (err) {
        console.error('❌ Error al eliminar producto:', err);
        return res.status(500).json({ error: 'Error al eliminar producto' });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Producto no encontrado o no pertenece al jefe' });
      }

      try {
        registrarHistorial(jefeId, 'eliminar producto', `Producto ID ${productoId} eliminado`);
      } catch (histErr) {
        console.error("⚠️ Error en registrarHistorial:", histErr);
      }

      res.json({ message: 'Producto eliminado correctamente' });
    });
  }).catch(err => {
    console.error('❌ Error en eliminación en cascada:', err);
    res.status(500).json({ error: 'No se pudo eliminar producto (restricciones de integridad)' });
  });
});

// ===============================
// ENDPOINT: Obtener movimientos
// ===============================
app.get('/movimientos', (req, res) => {
  const jefeId = req.query.jefe_id;

  if (!jefeId) {
    return res.status(400).json({ error: 'Se requiere el id del jefe' });
  }

  const query = `
    SELECT 
      m.id,
      m.tipo,
      m.cantidad,
      m.observacion,
      DATE_FORMAT(m.fecha, '%Y-%m-%d %H:%i:%s') AS fecha,
      p.nombre AS producto
    FROM movimientos m
    JOIN productos p ON m.producto_id = p.id
    WHERE m.jefe_id = ?
    ORDER BY m.fecha DESC
  `;

  connection.query(query, [jefeId], (err, results) => {
    if (err) {
      console.error('❌ Error al obtener movimientos:', err);
      return res.status(500).json({ error: 'Error al obtener movimientos' });
    }

    res.json(results);
  });
});

// Endpoint para obtener inventario de un jefe
app.get('/inventario/:jefeId', (req, res) => {
  const jefeId = req.params.jefeId;

  const query = `
    SELECT i.id, 
           p.nombre AS producto, 
           i.almacen, 
           i.lote, 
           i.fecha_ingreso AS fecha_ingreso, 
           i.cantidad, 
           i.en_venta
    FROM inventario i
    JOIN productos p ON i.producto_id = p.id
    WHERE p.jefe_id = ?
  `;

  connection.query(query, [jefeId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.put('/inventario/:id/venta', (req, res) => {
  const { id } = req.params;
  const { en_venta } = req.body;

  connection.query(
    'UPDATE inventario SET en_venta = ? WHERE id = ?',
    [en_venta, id],
    (err) => {
      if (err) return res.status(500).json({ error: 'Error al actualizar' });
      res.json({ success: true, id, en_venta });
    }
  );
});

// ==========================
// 📋 Ruta: Obtener detalle de una entrada
// ==========================
app.get("/entradas/:id", (req, res) => {
  const { id } = req.params;

  const query = `
    SELECT 
      e.id AS entrada_id,
      e.cantidad AS cantidad_entrada,
      e.precio_compra,
      e.fecha AS fecha_entrada,

      p.nombre AS producto,
      p.modelo,
      p.marca,
      p.descripcion AS producto_descripcion,
      p.ubicacion AS ubicacion_producto,

      pr.nombre AS proveedor,
      pr.contacto AS proveedor_contacto,
      pr.telefono AS proveedor_telefono,
      pr.email AS proveedor_email,
      pr.direccion AS proveedor_direccion,

      j.usuario AS jefe,

      i.lote,
      i.almacen,
      i.cantidad AS stock_inventario
    FROM entradas e
    LEFT JOIN productos p ON e.producto_id = p.id
    LEFT JOIN proveedores pr ON e.proveedor_id = pr.id
    LEFT JOIN jefe j ON e.jefe_id = j.id
    LEFT JOIN inventario i ON i.producto_id = e.producto_id
    WHERE e.id = ?
    LIMIT 1
  `;

  connection.query(query, [id], (err, results) => {
    if (err) return res.status(500).json({ error: "Error al obtener la entrada", details: err });
    if (!results.length) return res.status(404).json({ error: `Entrada con ID ${id} no encontrada` });

    const data = results[0];
    res.json({
      id: data.entrada_id,
      cantidad: data.cantidad_entrada,
      precio_compra: Number(data.precio_compra) || 0,
      fecha: data.fecha_entrada,
      producto: {
        nombre: data.producto || "Sin especificar",
        modelo: data.modelo || "—",
        marca: data.marca || "—",
        descripcion: data.producto_descripcion || "—",
        ubicacion: data.ubicacion_producto || "—"
      },
      proveedor: {
        nombre: data.proveedor || "N/A",
        contacto: data.proveedor_contacto || "—",
        telefono: data.proveedor_telefono || "—",
        email: data.proveedor_email || "—",
        direccion: data.proveedor_direccion || "—"
      },
      jefe: data.jefe || "Desconocido",
      inventario: {
        lote: data.lote || "—",
        almacen: data.almacen || "—",
        stock: data.stock_inventario || 0
      },
      observacion: "—" // si quieres, puedes añadir campo observacion en la tabla entradas
    });
  });
});

// ==========================
// 📦 Ruta: Salidas (opcional para futuro detalle)
// ==========================
app.get("/salidas/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT 
        s.id,
        p.nombre AS producto,
        s.cantidad,
        s.fecha,
        s.observacion,
        j.usuario AS jefe
      FROM salidas s
      LEFT JOIN productos p ON s.producto_id = p.id
      LEFT JOIN jefe j ON s.jefe_id = j.id
      WHERE s.id = ?
    `, [id]);

    if (!rows.length) return res.status(404).json({ error: "Salida no encontrada" });
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener la salida" });
  }
});

// ==========================
// 💰 Ruta: Ventas (opcional para detalle de venta)
// ==========================
app.get("/ventas/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT 
        v.id,
        c.nombre AS cliente,
        v.total,
        v.fecha,
        j.usuario AS jefe
      FROM ventas v
      LEFT JOIN clientes c ON v.cliente_id = c.id
      LEFT JOIN jefe j ON v.jefe_id = j.id
      WHERE v.id = ?
    `, [id]);

    if (!rows.length) return res.status(404).json({ error: "Venta no encontrada" });
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener la venta" });
  }
});



// ===============================
// Levantar el servidor
// ===============================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
