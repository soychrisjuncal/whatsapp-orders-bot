require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configuración de Twilio WhatsApp
const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? 
  twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : 
  null;

// Configuración de Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Store temporal para carritos de usuarios
const userCarts = new Map();
const userStates = new Map();

// Estados del bot
const STATES = {
  MAIN_MENU: 'main_menu',
  BROWSING_PRODUCTS: 'browsing_products',
  CART_REVIEW: 'cart_review',
  DELIVERY_INFO: 'delivery_info',
  PAYMENT_METHOD: 'payment_method',
  PAYMENT_CONFIRMATION: 'payment_confirmation',
  CONFIRMING_ORDER: 'confirming_order'
};

// Función para obtener el menú de Google Sheets
async function getMenu() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Menu!A:F',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) return [];
    
    const [headers, ...data] = rows;
    return data.map(row => ({
      id: row[0],
      name: row[1],
      description: row[2] || '',
      price: parseFloat(row[3]),
      category: row[4],
      available: row[5] === 'TRUE'
    })).filter(item => item.available);
  } catch (error) {
    console.error('Error getting menu:', error);
    return [];
  }
}

// Función para guardar pedido en Google Sheets
async function saveOrder(orderData) {
  try {
    const values = [[
      new Date().toISOString(),
      orderData.customerPhone,
      orderData.customerName,
      JSON.stringify(orderData.items),
      orderData.total,
      orderData.deliveryType,
      orderData.address || '',
      orderData.paymentMethod || 'Efectivo',
      orderData.paymentStatus || 'Pendiente',
      'NUEVO'
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Pedidos!A:K',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
  } catch (error) {
    console.error('Error saving order:', error);
  }
}

// Función para actualizar estado del pedido
async function updateOrderStatus(phone, newStatus) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Pedidos!A:K',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length <= 1) return false;
    
    // Buscar el pedido más reciente del usuario
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][1] === phone) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Pedidos!K${i + 1}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [[newStatus]] }
        });
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Error updating order status:', error);
    return false;
  }
}

// Función para formatear precios argentinos
function formatPrice(price) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0
  }).format(price);
}

// Función para generar link de pago de MercadoPago
function generateMercadoPagoLink(total, orderId, customerName) {
  // En producción, aquí usarías la API real de MercadoPago
  // Por ahora simulamos un link con los datos del pedido
  const encodedData = encodeURIComponent(`${customerName}-${orderId}-${total}`);
  return `https://mpago.la/2Qx8y9z?amount=${total}&concept=Pedido-${orderId.slice(-6)}`;
}

// Función para formatear el menú con pseudo-botones visuales
function formatMenuWithButtons(menu) {
  const categories = [...new Set(menu.map(item => item.category))];
  let message = "🍽️ *MENÚ SABORES DEL BARRIO*\n\n";
  
  categories.forEach(category => {
    message += `📋 *${category}*\n\n`;
    
    menu.filter(item => item.category === category).forEach(item => {
      message += `┌─ ${item.id}️⃣ ${item.name} ─┐\n`;
      message += `│ ${formatPrice(item.price)} │\n`;
      if (item.description) {
        message += `│ _${item.description}_ │\n`;
      }
      message += `└──────────────┘\n\n`;
    });
  });
  
  message += "*⚡ CÓMO PEDIR:*\n";
  message += "• Un producto: *1*\n";
  message += "• Varios: *1,2,3*\n";
  message += "• Ver carrito: *carrito*\n";
  message += "• Finalizar: *finalizar*";
  
  return message;
}

// Función para formatear el carrito mejorada - SIEMPRE muestra contenido
function formatCart(cart, showOptions = true) {
  let message = "🛒 *TU CARRITO*\n\n";
  let total = 0;
  
  if (!cart || cart.length === 0) {
    message += "Carrito vacío\n\n";
  } else {
    cart.forEach((item, index) => {
      const subtotal = item.price * item.quantity;
      total += subtotal;
      message += `${index + 1}. ${item.name}\n`;
      message += `   Cantidad: ${item.quantity} x ${formatPrice(item.price)} = ${formatPrice(subtotal)}\n\n`;
    });
  }
  
  message += `💰 *TOTAL: ${formatPrice(total)}*\n\n`;
  
  if (showOptions) {
    message += "*Opciones disponibles:*\n";
    message += "• Enviá un número para agregar productos\n";
    message += "• Enviá varios números separados por comas (ej: 1,2,3)\n";
    if (cart.length > 0) {
      message += "• *finalizar* - Completar pedido\n";
      message += "• *limpiar* - Vaciar carrito\n";
    }
    message += "• *menu* - Ver menú completo";
  }
  
  return message;
}

// Función para enviar mensajes simples
async function sendMessage(to, body) {
  if (!client) {
    console.error('Twilio client not initialized - check credentials');
    return;
  }
  
  try {
    await client.messages.create({
      body: body,
      from: 'whatsapp:+14155238886',
      to: to
    });
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

// Función para enviar mensajes con botones interactivos
async function sendInteractiveMessage(to, body, options = null) {
  if (!client) {
    console.error('Twilio client not initialized - check credentials');
    return;
  }
  
  try {
    if (options && options.type === 'buttons' && options.buttons) {
      // Enviar mensaje con botones de respuesta rápida (máximo 3)
      await client.messages.create({
        body: body,
        from: 'whatsapp:+14155238886',
        to: to,
        // Nota: Los botones interactivos requieren configuración especial en Twilio
        // Por ahora simulamos con texto estructurado
      });
    } else if (options && options.type === 'list' && options.listItems) {
      // Enviar mensaje con lista interactiva
      await client.messages.create({
        body: body,
        from: 'whatsapp:+14155238886',
        to: to,
        // Nota: Las listas interactivas requieren configuración especial en Twilio
        // Por ahora simulamos con texto estructurado
      });
    } else {
      // Mensaje simple
      await client.messages.create({
        body: body,
        from: 'whatsapp:+14155238886',
        to: to
      });
    }
  } catch (error) {
    console.error('Error sending interactive message:', error);
    // Fallback a mensaje simple
    await sendMessage(to, body);
  }
}

// Función para procesar pedido completo
async function processOrder(phone, customerName, cart, deliveryType, address = '', paymentMethod = 'efectivo') {
  const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const orderId = Date.now().toString();
  
  const orderData = {
    customerPhone: phone,
    customerName: customerName,
    items: cart,
    total: total,
    deliveryType: deliveryType,
    address: address,
    paymentMethod: paymentMethod,
    paymentStatus: paymentMethod === 'efectivo' ? 'Confirmado' : 'Pendiente',
    orderId: orderId
  };
  
  await saveOrder(orderData);
  
  // Limpiar carrito y estado
  userCarts.set(phone, []);
  userStates.set(phone, STATES.MAIN_MENU);
  
  // Mensaje de confirmación
  let confirmMessage = "✅ *PEDIDO CONFIRMADO*\n\n";
  confirmMessage += `📝 *Pedido #${orderId.slice(-6)}*\n\n`;
  
  cart.forEach(item => {
    confirmMessage += `• ${item.name} x${item.quantity} - ${formatPrice(item.price * item.quantity)}\n`;
  });
  
  confirmMessage += `\n💰 *Total: ${formatPrice(total)}*\n`;
  confirmMessage += `💳 *Pago: ${paymentMethod === 'efectivo' ? 'Efectivo' : 'MercadoPago'}*\n\n`;
  
  if (deliveryType === 'delivery') {
    confirmMessage += `🚚 *Delivery a:* ${address}\n`;
    confirmMessage += `⏱️ *Tiempo estimado:* 30-45 minutos\n\n`;
  } else {
    confirmMessage += `🏪 *Retiro en local*\n`;
    confirmMessage += `⏱️ *Estará listo en:* 20-30 minutos\n\n`;
  }
  
  if (paymentMethod === 'mercadopago') {
    confirmMessage += `💳 *Para completar el pago:*\n`;
    confirmMessage += `💰 Alias: SABORES.BARRIO.MP\n`;
    confirmMessage += `💵 Importe: ${formatPrice(total)}\n`;
    confirmMessage += `📝 Concepto: Pedido #${orderId.slice(-6)}\n\n`;
    confirmMessage += `📸 *Después del pago, enviá una foto del comprobante.*\n\n`;
  }
  
  confirmMessage += "¡Gracias por elegirnos! 😊\n";
  confirmMessage += "Te avisamos cuando esté listo para retirar/entregar.";
  
  await sendMessage(phone, confirmMessage);
  
  return orderId;
}

// Función para notificar al cliente
async function notifyCustomer(phone, message) {
  await sendMessage(phone, message);
}

// Webhook principal de WhatsApp mejorado
app.post('/webhook', async (req, res) => {
  const { Body, From, ProfileName, MediaUrl0, MediaContentType0 } = req.body;
  const message = Body ? Body.toLowerCase().trim() : '';
  const phone = From;
  const customerName = ProfileName || 'Cliente';
  
  console.log(`Mensaje de ${phone}: ${message}`);
  
  // Obtener estado actual del usuario
  let userState = userStates.get(phone) || STATES.MAIN_MENU;
  let cart = userCarts.get(phone) || [];
  
  try {
    // Manejar imágenes (comprobantes de pago)
    if (MediaUrl0 && MediaContentType0 && MediaContentType0.startsWith('image/')) {
      if (userState === STATES.PAYMENT_CONFIRMATION) {
        await updateOrderStatus(phone, 'PAGO_RECIBIDO');
        await sendMessage(phone, 
          "✅ *Comprobante recibido correctamente.*\n\n" +
          "📋 Verificaremos tu pago y te confirmaremos en breve.\n" +
          "🍽️ Una vez confirmado, comenzamos a preparar tu pedido.\n\n" +
          "¡Gracias por tu paciencia!"
        );
        userStates.set(phone, STATES.MAIN_MENU);
        return res.sendStatus(200);
      }
    }
    
    if (message === 'menu' || message === 'menú') {
      const menu = await getMenu();
      const menuText = formatMenuWithButtons(menu);
      let fullMessage = menuText + "\n\n";
      
      // SIEMPRE mostrar estado del carrito
      fullMessage += formatCart(cart, true);
      
      await sendInteractiveMessage(phone, fullMessage);
      userStates.set(phone, STATES.BROWSING_PRODUCTS);
      
    } else if (message === 'carrito') {
      const cartText = formatCart(cart, true);
      await sendInteractiveMessage(phone, cartText);
      
    } else if (message === 'limpiar') {
      userCarts.set(phone, []);
      await sendInteractiveMessage(phone, "🗑️ Carrito vaciado.\n\n" + formatCart([], true));
      userStates.set(phone, STATES.MAIN_MENU);
      
    } else if (message === 'cancelar') {
      // Usuario quiere cancelar su pedido actual
      if (cart.length > 0) {
        userCarts.set(phone, []);
        userStates.set(phone, STATES.MAIN_MENU);
        await sendInteractiveMessage(phone, 
          "❌ *Pedido cancelado*\n\n" +
          "Tu carrito ha sido vaciado.\n" +
          "Enviá *menu* cuando quieras hacer un nuevo pedido."
        );
      } else {
        await sendInteractiveMessage(phone, 
          "No tenés ningún pedido activo para cancelar.\n" +
          "Enviá *menu* para empezar un nuevo pedido."
        );
      }
      
    } else if (message === 'finalizar') {
      if (cart.length === 0) {
        await sendInteractiveMessage(phone, "Tu carrito está vacío. Enviá *menu* para agregar productos.");
        return res.sendStatus(200);
      }
      
      let confirmMessage = "🛒 *RESUMEN DE TU PEDIDO*\n\n";
      confirmMessage += formatCart(cart, false) + "\n\n";
      
      confirmMessage += "🏠 *SELECCIONÁ EL TIPO DE ENTREGA:*\n\n";
      confirmMessage += "┌─────────────────────┐\n";
      confirmMessage += "│  1️⃣  🚚 DELIVERY     │\n";
      confirmMessage += "│  2️⃣  🏪 RETIRO      │\n";
      confirmMessage += "└─────────────────────┘\n\n";
      confirmMessage += "Tocá *1* para delivery o *2* para retiro en local.";
      
      await sendInteractiveMessage(phone, confirmMessage, {
        type: 'buttons',
        buttons: ['1️⃣ Delivery', '2️⃣ Retiro']
      });
      userStates.set(phone, STATES.DELIVERY_INFO);
      
    } else if (userState === STATES.DELIVERY_INFO) {
      if (message === '1') {
        await sendInteractiveMessage(phone, "📍 *DIRECCIÓN PARA DELIVERY*\n\nPor favor enviá tu dirección completa:\n\n*Ejemplo:* Av. Corrientes 1234, CABA");
        userStates.set(phone, STATES.PAYMENT_METHOD);
        userCarts.set(phone + '_delivery', 'delivery');
        
      } else if (message === '2') {
        userCarts.set(phone + '_delivery', 'pickup');
        
        let paymentMessage = "💳 *MÉTODO DE PAGO*\n\n";
        paymentMessage += formatCart(cart, false) + "\n\n";
        paymentMessage += "🏪 *RETIRO EN LOCAL*\n\n";
        paymentMessage += "┌─────────────────────────┐\n";
        paymentMessage += "│  1️⃣  💵 EFECTIVO       │\n";
        paymentMessage += "│  2️⃣  💳 MERCADOPAGO    │\n";
        paymentMessage += "└─────────────────────────┘\n\n";
        paymentMessage += "Tocá *1* para pagar en efectivo o *2* para MercadoPago.";
        
        await sendInteractiveMessage(phone, paymentMessage, {
          type: 'buttons',
          buttons: ['1️⃣ Efectivo', '2️⃣ MercadoPago']
        });
        userStates.set(phone, STATES.PAYMENT_METHOD);
        
      } else {
        await sendInteractiveMessage(phone, 
          "❌ *Opción no válida*\n\n" +
          "Por favor seleccioná:\n" +
          "1️⃣ Delivery\n" +
          "2️⃣ Retiro en local"
        );
      }
      
    } else if (userState === STATES.PAYMENT_METHOD) {
      const deliveryType = userCarts.get(phone + '_delivery') || 'pickup';
      const address = message;
      
      if (deliveryType === 'delivery' && !userCarts.get(phone + '_address')) {
        // Guardar dirección y pedir método de pago
        userCarts.set(phone + '_address', address);
        
        let paymentMessage = "💳 *MÉTODO DE PAGO*\n\n";
        paymentMessage += formatCart(cart, false) + "\n\n";
        paymentMessage += `🚚 *Delivery a:* ${address}\n\n`;
        paymentMessage += "*Seleccioná cómo vas a pagar:*\n";
        paymentMessage += "1️⃣ 💵 Efectivo (al recibir)\n";
        paymentMessage += "2️⃣ 💳 MercadoPago (transferencia)\n\n";
        paymentMessage += "Enviá *1* para efectivo o *2* para MercadoPago.";
        
        await sendMessage(phone, paymentMessage);
        return res.sendStatus(200);
      }
      
      if (message === '1') {
        // Pago en efectivo
        const finalAddress = userCarts.get(phone + '_address') || '';
        await processOrder(phone, customerName, cart, deliveryType, finalAddress, 'efectivo');
        
        // Limpiar datos temporales
        userCarts.delete(phone + '_delivery');
        userCarts.delete(phone + '_address');
        
      } else if (message === '2') {
        // Pago con MercadoPago
        const finalAddress = userCarts.get(phone + '_address') || '';
        const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const orderId = Date.now().toString();
        
        // Generar link de MercadoPago
        const mpLink = generateMercadoPagoLink(total, orderId, customerName);
        
        let mpMessage = "💳 *PAGAR CON MERCADOPAGO*\n\n";
        mpMessage += formatCart(cart, false) + "\n\n";
        mpMessage += `💰 *Total a pagar: ${formatPrice(total)}*\n\n`;
        mpMessage += "🔗 *OPCIÓN 1 - Link de pago:*\n";
        mpMessage += `${mpLink}\n\n`;
        mpMessage += "💰 *OPCIÓN 2 - Transferencia:*\n";
        mpMessage += `📱 Alias: SABORES.BARRIO.MP\n`;
        mpMessage += `💵 Importe: ${formatPrice(total)}\n`;
        mpMessage += `📝 Concepto: Pedido #${orderId.slice(-6)}\n\n`;
        mpMessage += "📸 *Después del pago, enviá una foto del comprobante.*\n\n";
        mpMessage += "Una vez que recibamos el comprobante, procesaremos tu pedido.";
        
        await sendInteractiveMessage(phone, mpMessage);
        
        // Procesar pedido como pendiente de pago
        await processOrder(phone, customerName, cart, deliveryType, finalAddress, 'mercadopago');
        userStates.set(phone, STATES.PAYMENT_CONFIRMATION);
        
        // Limpiar datos temporales
        userCarts.delete(phone + '_delivery');
        userCarts.delete(phone + '_address');
        
      } else {
        await sendInteractiveMessage(phone, "❌ *Opción no válida*\n\nPor favor seleccioná:\n1️⃣ Efectivo\n2️⃣ MercadoPago");
      }
      
    } else if (/^[\d,\s]+$/.test(message)) {
      // Usuario seleccionó productos (múltiples números: 1,2,3 o 1 2 3)
      const menu = await getMenu();
      const productIds = message.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      
      let addedProducts = [];
      let notFoundProducts = [];
      
      productIds.forEach(productId => {
        const product = menu.find(item => parseInt(item.id) === productId);
        
        if (product) {
          const existingItem = cart.find(item => item.id === product.id);
          
          if (existingItem) {
            existingItem.quantity += 1;
          } else {
            cart.push({
              ...product,
              quantity: 1
            });
          }
          addedProducts.push(product.name);
        } else {
          notFoundProducts.push(productId.toString());
        }
      });
      
      userCarts.set(phone, cart);
      
      let responseMessage = "";
      
      if (addedProducts.length > 0) {
        responseMessage += "✅ *Productos agregados:*\n";
        addedProducts.forEach(name => {
          responseMessage += `• ${name}\n`;
        });
        responseMessage += "\n";
      }
      
      if (notFoundProducts.length > 0) {
        responseMessage += "❌ *Productos no encontrados:* " + notFoundProducts.join(", ") + "\n\n";
      }
      
      // SIEMPRE mostrar carrito actualizado
      responseMessage += formatCart(cart, true);
      
      await sendMessage(phone, responseMessage);
      userStates.set(phone, STATES.BROWSING_PRODUCTS);
      
    } else {
      // Mensaje de bienvenida
      const welcomeMessage = 
        `¡Hola ${customerName}! 👋\n\n` +
        `Bienvenido a nuestro sistema de pedidos.\n\n` +
        `Enviá *menu* para ver nuestros productos disponibles.`;
      
      await sendMessage(phone, welcomeMessage);
      userStates.set(phone, STATES.MAIN_MENU);
    }
    
  } catch (error) {
    console.error('Error processing message:', error);
    await sendMessage(phone, "❌ Hubo un error. Por favor intentá nuevamente o enviá *menu* para empezar.");
  }
  
  res.sendStatus(200);
});

// Ruta para el panel de administración
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API para obtener pedidos
app.get('/api/orders', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Pedidos!A:K',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return res.json([]);
    }
    
    const [headers, ...data] = rows;
    const orders = data.map((row, index) => ({
      rowIndex: index + 2,
      date: row[0],
      phone: row[1],
      customer: row[2],
      items: JSON.parse(row[3] || '[]'),
      total: parseFloat(row[4]),
      deliveryType: row[5],
      address: row[6],
      paymentMethod: row[7] || 'Efectivo',
      paymentStatus: row[8] || 'Pendiente',
      status: row[9] || 'NUEVO'
    }));
    
    res.json(orders);
  } catch (error) {
    console.error('Error getting orders:', error);
    res.status(500).json({ error: 'Error getting orders' });
  }
});

// API para actualizar estado de pedido
app.post('/api/orders/:phone/status', async (req, res) => {
  try {
    const { phone } = req.params;
    const { status } = req.body;
    
    const success = await updateOrderStatus(`whatsapp:${phone}`, status);
    
    if (success) {
      // Enviar notificación al cliente según el estado
      let notificationMessage = "";
      
      switch (status) {
        case 'PREPARANDO':
          notificationMessage = "👨‍🍳 ¡Tu pedido se está preparando!\n\nTe avisamos cuando esté listo. ⏱️";
          break;
        case 'LISTO':
          notificationMessage = "🎉 ¡Tu pedido está listo!\n\n" +
            "🏪 Ya podés pasar a retirarlo.\n" +
            "📍 Dirección: [Tu dirección del local]\n\n" +
            "¡Te esperamos! 😊";
          break;
        case 'EN_DELIVERY':
          notificationMessage = "🚚 ¡Tu pedido salió para delivery!\n\n" +
            "📍 Llega a tu dirección en 15-20 minutos.\n" +
            "¡Mantenete atento! 📱";
          break;
        case 'ENTREGADO':
          notificationMessage = "✅ ¡Pedido entregado!\n\n" +
            "🙏 Gracias por elegirnos.\n" +
            "⭐ Tu opinión es muy importante para nosotros.";
          break;
        case 'FINALIZADO':
          notificationMessage = "🏁 *Pedido finalizado*\n\n" +
            "✅ Tu pedido ha sido completado exitosamente.\n" +
            "¡Esperamos verte pronto! 😊";
          break;
        case 'CANCELADO':
          notificationMessage = "❌ *Pedido cancelado*\n\n" +
            "😔 Tu pedido ha sido cancelado.\n" +
            "Si tenés alguna consulta, no dudes en contactarnos.\n\n" +
            "¡Esperamos poder atenderte pronto! 🙏";
          break;
      }
      
      if (notificationMessage) {
        await notifyCustomer(`whatsapp:${phone}`, notificationMessage);
      }
      
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Order not found' });
    }
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Error updating order status' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Sistema de Pedidos WhatsApp funcionando en puerto ${PORT}`);
  console.log(`📱 Panel: http://localhost:${PORT}`);
});