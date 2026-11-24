# 🌱 HuellaViva UAN — Estimador Institucional de Huella de Carbono

Aplicación web desarrollada para la **Universidad Antonio Nariño (UAN)** que permite a estudiantes, profesores y personal administrativo estimar su huella de carbono mensual asociada a hábitos del hogar y desplazamientos hacia el campus, bajo lineamientos de protección de datos personales (Ley 1581 de 2012) y privacidad diferencial en reportes institucionales.

> **Alcance metodológico:** Herramienta educativa de estimación basada en factores promedio publicados (UPME SIN, FECOC y referencias internacionales adaptadas). No constituye un inventario verificado ni registro oficial ante RENARE.

---

## 1. Arquitectura y Estructura del Proyecto

El sistema sigue una arquitectura **Frontend Modular (Vanilla JS ES Modules)** conectada a **Supabase (PostgreSQL, Auth, Row Level Security y Funciones RPC)**.

```text
Huella-viva/
├── README.md                 # Documentación técnica del sistema
└── src/
    ├── index.html            # Estructura semántica de vistas (Acceso, Encuesta, Informe, ARCO, Admin)
    ├── styles.css            # Diseño institucional responsivo, tarjetas por categoría y gráficos CSS
    ├── config.js             # Credenciales públicas del proyecto Supabase (URL y Anon Key)
    ├── supabaseClient.js     # Inicialización del cliente Supabase
    ├── calculator.js         # Motor de cálculo de emisiones y generador de recomendaciones
    └── app.js                # Controlador principal, gestión de sesión, CRUD y renderizado dinámico
```

---

## 2. Funcionalidades Principales

### A. Autenticación y Gestión de Perfil
* **Registro e inicio de sesión:** Validación de correo institucional/personal, confirmación de contraseña, selección de **estamento** (`estudiante`, `profesor`, `administrativo`) y **sede/campus UAN** (`Bogotá - Sede Principal`, `Bogotá - Sede Sur`, `Sede Medellín`, `Sede Cali`, `Sede Santa Marta`).
* **Sincronización de metadatos:** Persistencia automática del campus y estamento tanto en `auth.users` (`user_metadata`) como en la tabla `public.profiles`.

### B. Módulo del Participante (Flujo en 3 Pasos)
1. **Autorización de Datos (Paso 1):** Presenta la versión vigente del aviso de privacidad (`consent_versions`) y registra la aceptación explícita con marca de tiempo (`consents`).
2. **Encuesta de Actividad Mensual (Paso 2):**
   * **1. Energía eléctrica del hogar:** Cálculo proporcional per cápita según integrantes del hogar (`kWh / personas`), con opción de estimación por rango de facturación en COP cuando no se dispone del recibo.
   * **2. Gas doméstico:** Cálculo proporcional per cápita para **Gas Natural Residencial** (`m³/mes`) o **GLP en cilindro** (`kg/mes`).
   * **3. Desplazamiento cotidiano al campus:** Cálculo mensual a partir de días asistidos, distancia ida/vuelta (`km`) y modo de transporte (`a pie/bicicleta`, `transporte público`, `motocicleta`, `automóvil particular`).
   * **4. Viajes aéreos:** Contabilización opcional de trayectos nacionales e internacionales en el periodo.
3. **Informe Individual (Paso 3):**
   * Indicadores clave (`kg CO₂e` y `toneladas CO₂e`), categoría de mayor impacto y versión metodológica.
   * Gráfico circular (`conic-gradient`) con distribución porcentual por categoría.
   * Tabla trazable con fórmula aplicada (`Actividad × Factor`), fuente oficial, año de referencia y etiqueta de dato (`Reportado` vs. `Estimado`).
   * Recomendaciones personalizadas según los resultados obtenidos.

### C. Derechos ARCO y Control de Cuenta
* Registro y seguimiento de solicitudes de **Consulta**, **Corrección** y **Supresión** (`data_requests`) conforme a la Ley 1581 de 2012.
* Revocatoria automática de consentimiento en solicitudes de supresión.
* **Eliminación definitiva de perfil (`delete_my_account`):** Permite al usuario borrar permanentemente su perfil, respuestas, cálculos y credenciales de autenticación.

### D. Panel Institucional (Administración)
* **Dashboard Poblacional Agregado:** Filtra indicadores por periodo, campus y estamento.
* **Regla de Privacidad ($n < 10$):** Oculta automáticamente los promedios de emisiones cuando un subgrupo tiene menos de 10 participantes para evitar la reidentificación indirecta.
* **Exportación CSV:** Descarga de reportes agregados respetando las celdas protegidas por privacidad.
* **Gestión de Periodos:** Apertura y cierre de ventanas de recolección (`survey_periods`).
* **Versionamiento de Factores de Emisión:** Actualización controlada de factores (`emission_factors`) desactivando la versión anterior y creando una nueva con trazabilidad histórica.
* **Atención de Solicitudes ARCO:** Cambio de estado (`pendiente`, `en_revision`, `atendida`).

---

## 3. Metodología de Cálculo (`MET-HV-UAN-v1.0`)

Para cada categoría $i$, las emisiones mensuales $E_i$ (en $\text{kg CO}_2\text{e}$) se calculan mediante:

$$E_i = A_i \times FE_i$$

Donde:
* **Electricidad:** $A_{\text{elec}} = \frac{\text{Consumo hogar (kWh)}}{\text{Personas en el hogar}}$
* **Gas doméstico:** $A_{\text{gas}} = \frac{\text{Consumo gas (m}^3 \text{ o kg)}}{\text{Personas en el hogar}}$
* **Transporte al campus:** $A_{\text{trans}} = \text{Días asistidos} \times \text{Distancia ida y vuelta (km)}$
* **Viajes aéreos:** $A_{\text{aéreo}} = \text{Número de trayectos}$
* **$FE_i$:** Factor de emisión vigente almacenado en `emission_factors` (fuentes oficiales UPME SIN, FECOC y factores de referencia adaptados).

---

## 4. Modelo de Datos en Supabase (PostgreSQL)

| Tabla | Propósito |
| :--- | :--- |
| `profiles` | Estamento, campus y bandera de administrador (`is_admin`) vinculada a `auth.users`. |
| `consent_versions` | Textos y versiones del aviso de privacidad institucional. |
| `consents` | Registro de aceptación o revocatoria del consentimiento por usuario. |
| `survey_periods` | Periodos de medición activos o cerrados y versión metodológica asociada. |
| `surveys` | Cabecera de encuesta por usuario y periodo (restricción única `profile_id, period_id`). |
| `activity_answers` | Respuestas normalizadas por pregunta, unidad e indicador `is_estimated`. |
| `emission_factors` | Catálogo versionado de factores de emisión, unidades, fuente y vigencia. |
| `calculations` | Resultado total consolidado (`total_kgco2e`) por encuesta. |
| `calculation_details` | Desglose por categoría vinculando respuesta, factor aplicado y emisión resultante. |
| `data_requests` | Solicitudes ARCO de los usuarios y su estado de gestión. |
| `admin_audit_log` | Bitácora automática de auditoría mediante triggers sobre `profiles`, `surveys` y `emission_factors`. |

### Seguridad y Funciones RPC
* **Row Level Security (RLS):** Habilitado en todas las tablas; cada participante solo accede a sus propios registros y los administradores consultan mediante `public.is_admin()`.
* **Protección de rol:** El trigger `trg_protect_profile_admin` impide que un usuario modifique su propio campo `is_admin` desde el cliente.
* **`get_aggregated_dashboard(...)`:** Función `SECURITY DEFINER` que calcula promedios agregados aplicando el umbral de privacidad $n < 10$.
* **`delete_my_account()`:** Función `SECURITY DEFINER` que elimina en cascada los datos del participante y su registro en `auth.users`.

---

## 5. Ejecución Local y Despliegue

### Requisitos previos
* Un proyecto activo en [Supabase](https://supabase.com/) con el esquema SQL ejecutado.
* Credenciales configuradas en `src/config.js` (`SUPABASE_URL` y `SUPABASE_ANON_KEY`).
* Un servidor web local HTTP (necesario porque el navegador bloquea módulos ES `type="module"` bajo el protocolo `file://` por políticas CORS).

### Ejecución en local (Visual Studio Code)
1. Abre la carpeta del proyecto en **Visual Studio Code**.
2. Instala la extensión **Live Server** (si no la tienes instalada).
3. Haz clic derecho sobre `src/index.html` y selecciona **Open with Live Server** (o pulsa **Go Live** en la barra inferior).
4. Accede desde el navegador a `http://127.0.0.1:5500/src/index.html`.

### Despliegue en producción
Al tratarse de una aplicación estática sin paso de compilación (*build*), puede publicarse directamente en **Vercel**, **Netlify**, **GitHub Pages** o **Cloudflare Pages** apuntando la raíz del sitio a la carpeta `src/` y registrando la URL resultante en **Authentication > URL Configuration** dentro de Supabase.
