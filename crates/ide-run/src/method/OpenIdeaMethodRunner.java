import java.io.*;
import java.lang.annotation.Annotation;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;

/** JDK 8 compatible. Framework classes are deliberately loaded reflectively from the project. */
public final class OpenIdeaMethodRunner {
    private Object mapper;
    private final List<Object> mockCalls = new ArrayList<Object>();
    private final Map<String,Object> dependencies = new LinkedHashMap<String,Object>();
    private Object context;

    public static void main(String[] args) {
        Path dir = Paths.get(args[1]);
        try {
            if ("--prepare".equals(args[0])) prepare(dir);
            else new OpenIdeaMethodRunner().invoke(dir);
            System.exit(0); // Application-created non-daemon threads must not retain a disposable test JVM.
        } catch (Throwable failure) {
            Throwable error = unwrap(failure);
            System.err.println("[Method Test] "+error);
            try { failure(dir, error); } catch (Exception ignored) { ignored.printStackTrace(System.err); }
            System.exit(1);
        }
    }

    private static void prepare(Path dir) throws Exception {
        Files.deleteIfExists(dir.resolve("result.json"));
        Properties p = new Properties();
        try (Reader reader = Files.newBufferedReader(dir.resolve("launch.properties"), StandardCharsets.UTF_8)) { p.load(reader); }
        List<String> build = new ArrayList<String>();
        if (System.getProperty("os.name").startsWith("Windows")) Collections.addAll(build, "cmd.exe", "/c");
        build.add(p.getProperty("maven"));
        for (int i=0; p.containsKey("mavenOption"+i); i++) build.add(p.getProperty("mavenOption"+i));
        Collections.addAll(build, "--batch-mode", "-Dstyle.color=never", "-DskipTests", "-Dmaven.test.skip=false",
            "test-compile", "dependency:build-classpath", "help:effective-pom",
            "-DincludeScope=test", "-Dmdep.outputFile="+dir.resolve("classpath.txt"), "-Doutput="+dir.resolve("effective-pom.xml"));
        if (!p.getProperty("profiles", "").isEmpty()) build.add("-P"+p.getProperty("profiles"));
        File module = new File(p.getProperty("module"));
        System.out.println("[Method Test] Building "+module+" with the project JDK; tests are not executed.");
        int timeout = Integer.parseInt(p.getProperty("timeout"));
        long deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(timeout);
        runChild(build, module, deadline);
        String cp = new String(Files.readAllBytes(dir.resolve("classpath.txt")), StandardCharsets.UTF_8).trim();
        String runner = Paths.get(OpenIdeaMethodRunner.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
        List<String> paths = new ArrayList<String>();
        paths.add(runner);
        // Honor custom output directories in the effective Maven model.
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        Document pom = factory.newDocumentBuilder().parse(dir.resolve("effective-pom.xml").toFile());
        Element project = pom.getDocumentElement();
        if ("projects".equals(project.getTagName())) {
            for (Node n=project.getFirstChild(); n!=null; n=n.getNextSibling()) if (n instanceof Element) { project=(Element)n; break; }
        }
        Element effectiveBuild = child(project, "build");
        paths.add(text(effectiveBuild, "testOutputDirectory", new File(module,"target/test-classes").toString()));
        paths.add(text(effectiveBuild, "outputDirectory", new File(module,"target/classes").toString()));
        if (!cp.isEmpty()) paths.add(cp);
        List<String> launch = new ArrayList<String>();
        Collections.addAll(launch, p.getProperty("java"), "-Xmx"+p.getProperty("heap")+"m");
        String jdwp=System.getenv("OPENIDEA_METHOD_JDWP");
        if (jdwp!=null && !jdwp.isEmpty()) launch.add(jdwp);
        Collections.addAll(launch, "-cp", join(paths,File.pathSeparator), "OpenIdeaMethodRunner", "--invoke", dir.toString());
        System.out.println("[Method Test] Invoking in an isolated JVM (heap limit "+p.getProperty("heap")+" MB).");
        runChild(launch, module, jdwp==null ? deadline : Long.MAX_VALUE);
    }

    private static Element child(Element parent,String name) {
        if (parent==null) return null;
        for (Node node=parent.getFirstChild(); node!=null; node=node.getNextSibling())
            if (node instanceof Element && name.equals(node.getNodeName())) return (Element)node;
        return null;
    }
    private static String text(Element parent,String name,String fallback) {
        Element node=child(parent,name); return node==null ? fallback : node.getTextContent().trim();
    }
    private static String join(List<String> values,String separator) {
        StringBuilder out=new StringBuilder();
        for (String value:values) { if (out.length()>0) out.append(separator); out.append(value); } return out.toString();
    }
    private static void runChild(List<String> args,File cwd,long deadline) throws Exception {
        final Process process=new ProcessBuilder(args).directory(cwd).inheritIO().start();
        Thread shutdown=new Thread(new Runnable() { public void run() { process.destroy(); } });
        Runtime.getRuntime().addShutdownHook(shutdown);
        try {
            boolean exited;
            if (deadline==Long.MAX_VALUE) {process.waitFor();exited=true;}
            else exited=process.waitFor(Math.max(0,deadline-System.nanoTime()),TimeUnit.NANOSECONDS);
            if (!exited) {
                process.destroy(); if (!process.waitFor(2,TimeUnit.SECONDS)) process.destroyForcibly();
                throw new IllegalStateException("Method test timed out; increase the timeout or use Debug.");
            }
            if (process.exitValue()!=0) throw new IllegalStateException("Process exited with code "+process.exitValue()+". See the Console for build/invocation errors.");
        } finally {
            if (process.isAlive()) {process.destroy();if (!process.waitFor(2,TimeUnit.SECONDS)) process.destroyForcibly();}
            try {Runtime.getRuntime().removeShutdownHook(shutdown);} catch (IllegalStateException ignored) {}
        }
    }

    @SuppressWarnings("unchecked")
    private void invoke(Path dir) throws Exception {
        long started=System.nanoTime();
        Map<String,Object> result=new LinkedHashMap<String,Object>();
        Throwable failure=null;
        try {
            try {
                mapper=Class.forName("com.fasterxml.jackson.databind.ObjectMapper").newInstance();
                mapper.getClass().getMethod("findAndRegisterModules").invoke(mapper);
            } catch (ClassNotFoundException e) {
                throw new IllegalStateException("Method tests require Jackson 2 (jackson-databind) on this module's test classpath.",e);
            }
            Map<String,Object> request=read(new String(Files.readAllBytes(dir.resolve("request.json")),StandardCharsets.UTF_8));
            Class<?> target=Class.forName((String)request.get("className"));
            Method method=findMethod(target,(String)request.get("methodName"),(List<String>)request.get("parameterTypes"));
            if (Future.class.isAssignableFrom(method.getReturnType()) || CompletionStage.class.isAssignableFrom(method.getReturnType()) ||
                hasType(method.getReturnType(),"org.reactivestreams.Publisher"))
                throw new IllegalArgumentException("First-version method tests support synchronous public methods.");
            Map<String,Object> definitions=read((String)request.get("dependenciesJson"));
            boolean spring="spring".equals(request.get("mode"));
            for (Map.Entry<String,Object> entry:definitions.entrySet()) {
                if (!(entry.getValue() instanceof Map)) throw new IllegalArgumentException("Dependency "+entry.getKey()+" must be an object.");
                Map<String,Object> spec=(Map<String,Object>)entry.getValue();
                String kind=string(spec.get("kind"),"mock");
                Field field=findField(target,entry.getKey());
                Class<?> type=spec.containsKey("className") ? Class.forName((String)spec.get("className")) : field==null ? null : field.getType();
                if (type==null) throw new IllegalArgumentException("Dependency "+entry.getKey()+": supply className or use a field name.");
                if ("instance".equals(kind) && spring) continue;
                Object value;
                if ("mock".equals(kind)) value=mock(entry.getKey(),type,spec);
                else if ("value".equals(kind)) value=convert(spec.get("value"),field==null ? type : field.getGenericType());
                else if ("instance".equals(kind)) value=type.getDeclaredConstructor().newInstance();
                else throw new IllegalArgumentException("Unknown dependency kind: "+kind);
                dependencies.put(entry.getKey(),value);
            }
            Object receiver=null;
            if (spring) receiver=spring(target,request,definitions,!Modifier.isStatic(method.getModifiers()));
            else if (!Modifier.isStatic(method.getModifiers())) receiver=object(target);
            List<Object> values=(List<Object>)readAny((String)request.get("argumentsJson"),List.class);
            Type[] types=method.getGenericParameterTypes();
            if (values.size()!=types.length) throw new IllegalArgumentException("Argument count no longer matches the compiled method; reopen it from the editor.");
            Object[] arguments=new Object[types.length];
            for (int i=0;i<types.length;i++) arguments[i]=convert(values.get(i),types[i]);
            System.out.println("[Method Test] "+target.getName()+"#"+method.getName()+" ("+(spring ? "Spring container" : "Object")+")");
            Method callable=method;
            if (receiver!=null && !method.getDeclaringClass().isInstance(receiver)) {
                callable=null;
                for (Class<?> face:receiver.getClass().getInterfaces()) try {
                    callable=face.getMethod(method.getName(),method.getParameterTypes()); break;
                } catch (NoSuchMethodException ignored) {}
                if (callable==null) throw new IllegalArgumentException("The Spring proxy does not expose "+method.getName()+". Use a public interface method or class-based proxy configuration.");
            }
            Object value=callable.invoke(receiver,arguments);
            result.put("success",true);
            result.put("valueJson",json(value));
        } catch (Throwable error) { failure=unwrap(error); }
        finally {
            if (context!=null) try { context.getClass().getMethod("close").invoke(context); }
                catch (Throwable error) { if (failure==null) failure=unwrap(error); }
        }
        if (failure!=null) {
            result.put("success",false); result.put("error",failure.toString());
            result.put("stackTrace",stack(failure)); failure.printStackTrace(System.err);
        }
        if (mapper==null) { failure(dir,failure); System.exit(1); return; }
        result.put("durationMs",(System.nanoTime()-started)/1000000.0);
        result.put("mockCallsJson",json(mockCalls));
        atomic(dir,json(result));
        System.out.println("[Method Test] "+(failure==null ? "Completed" : "Failed")+" in "+result.get("durationMs")+" ms.");
        if (failure!=null) System.exit(1);
    }

    private static boolean hasType(Class<?> type,String name) {
        if (type==null) return false; if (name.equals(type.getName())) return true;
        for (Class<?> face:type.getInterfaces()) if (hasType(face,name)) return true;
        return hasType(type.getSuperclass(),name);
    }
    private static Method findMethod(Class<?> target,String name,List<String> types) {
        List<Method> matches=new ArrayList<Method>();
        for (Method method:target.getMethods())
            if (!method.isBridge() && !method.isSynthetic() && method.getName().equals(name) && signature(method,types)) matches.add(method);
        if (matches.size()!=1) throw new IllegalArgumentException("Public method "+name+types+" is missing or ambiguous in "+target.getName()+". Check the implementation class and compiled signature.");
        return matches.get(0);
    }
    private static boolean signature(Method method,List<String> types) {
        Class<?>[] parameters=method.getParameterTypes(); if (parameters.length!=types.size()) return false;
        for (int i=0;i<parameters.length;i++) {
            String expected=types.get(i).replace("...","[]").replaceAll("<.*>","").replace(" ","");
            Class<?> actual=parameters[i];
            if (!expected.equals(actual.getCanonicalName()) && !expected.equals(actual.getName()) && !expected.equals(actual.getSimpleName())) return false;
        }
        return true;
    }
    private static Field findField(Class<?> type,String name) {
        for (Class<?> at=type;at!=null;at=at.getSuperclass()) try { return at.getDeclaredField(name); } catch (NoSuchFieldException ignored) {}
        return null;
    }
    private static List<Field> fields(Class<?> type) {
        List<Field> out=new ArrayList<Field>();
        for (Class<?> at=type;at!=null;at=at.getSuperclass()) Collections.addAll(out,at.getDeclaredFields()); return out;
    }
    private static boolean injection(AnnotatedElement element) {
        for (Annotation annotation:element.getAnnotations()) {
            String name=annotation.annotationType().getSimpleName();
            if ("Autowired".equals(name) || "Inject".equals(name) || "Resource".equals(name)) return true;
        } return false;
    }
    private Object object(Class<?> target) throws Exception {
        List<Constructor<?>> constructors=Arrays.asList(target.getDeclaredConstructors());
        Collections.sort(constructors,new Comparator<Constructor<?>>() { public int compare(Constructor<?> a,Constructor<?> b) {
            int annotated=Boolean.compare(injection(b),injection(a));
            return annotated!=0 ? annotated : Integer.compare(b.getParameterTypes().length,a.getParameterTypes().length);
        }});
        Object receiver=null;
        for (Constructor<?> constructor:constructors) {
            Parameter[] parameters=constructor.getParameters(); Object[] args=new Object[parameters.length]; boolean valid=true;
            for (int i=0;i<parameters.length;i++) {
                Parameter parameter=parameters[i];
                Object value=dependencies.get(parameter.getName());
                if (value==null || !box(parameter.getType()).isInstance(value)) {
                    List<Object> candidates=new ArrayList<Object>();
                    for (Object dependency:dependencies.values()) if (dependency!=null && box(parameter.getType()).isInstance(dependency)) candidates.add(dependency);
                    if (candidates.size()==1) value=candidates.get(0); else { valid=false; break; }
                }
                args[i]=value;
            }
            if (valid) { constructor.setAccessible(true); receiver=constructor.newInstance(args); break; }
            if (injection(constructor)) break;
        }
        if (receiver==null) throw new IllegalArgumentException("Cannot construct "+target.getName()+"; configure constructor dependencies or use Spring mode.");
        for (Field field:fields(target)) {
            if (Modifier.isStatic(field.getModifiers())) continue; field.setAccessible(true);
            if (dependencies.containsKey(field.getName())) {
                Object value=dependencies.get(field.getName());
                if (Modifier.isFinal(field.getModifiers()) && field.get(receiver)!=value)
                    throw new IllegalArgumentException("Final dependency "+field.getName()+" must be supplied through its constructor.");
                if (!Modifier.isFinal(field.getModifiers())) field.set(receiver,value);
            } else if (injection(field) && field.get(receiver)==null)
                throw new IllegalArgumentException("Missing dependency "+field.getName()+" ("+field.getType().getName()+"). Configure it in Dependencies.");
            else for (Annotation annotation:field.getAnnotations())
                if ("Value".equals(annotation.annotationType().getSimpleName()))
                    throw new IllegalArgumentException("Property injection for "+field.getName()+" requires Spring mode or an explicit value dependency.");
        }
        return receiver;
    }
    private static Class<?> box(Class<?> type) {
        if (!type.isPrimitive()) return type;
        if (type==boolean.class) return Boolean.class; if (type==char.class) return Character.class;
        if (type==byte.class) return Byte.class; if (type==short.class) return Short.class;
        if (type==int.class) return Integer.class; if (type==long.class) return Long.class;
        if (type==float.class) return Float.class; return Double.class;
    }

    @SuppressWarnings("unchecked")
    private Object spring(Class<?> target,Map<String,Object> request,Map<String,Object> definitions,boolean instance) throws Exception {
        Class<?> ctx=Class.forName("org.springframework.context.annotation.AnnotationConfigApplicationContext");
        context=ctx.newInstance();
        Object environment=ctx.getMethod("getEnvironment").invoke(context);
        Class<?> configurableEnvironment=Class.forName("org.springframework.core.env.ConfigurableEnvironment");
        List<String> profiles=(List<String>)request.get("profiles");
        configurableEnvironment.getMethod("setActiveProfiles",String[].class).invoke(environment,(Object)profiles.toArray(new String[0]));
        Map<String,Object> properties=read((String)request.get("propertiesJson"));
        Object source=Class.forName("org.springframework.core.env.MapPropertySource").getConstructor(String.class,Map.class).newInstance("openidea-method",properties);
        Object sources=configurableEnvironment.getMethod("getPropertySources").invoke(environment);
        Class.forName("org.springframework.core.env.MutablePropertySources").getMethod("addFirst",Class.forName("org.springframework.core.env.PropertySource")).invoke(sources,source);
        Object factory=ctx.getMethod("getBeanFactory").invoke(context);
        Method singleton=Class.forName("org.springframework.beans.factory.config.SingletonBeanRegistry").getMethod("registerSingleton",String.class,Object.class);
        for (Map.Entry<String,Object> dependency:dependencies.entrySet()) singleton.invoke(factory,dependency.getKey(),dependency.getValue());
        List<Class<?>> classes=new ArrayList<Class<?>>(); if (instance) classes.add(target);
        for (Object name:(List<Object>)request.get("configurationClasses")) classes.add(Class.forName((String)name));
        for (Map.Entry<String,Object> entry:definitions.entrySet()) {
            Map<String,Object> spec=(Map<String,Object>)entry.getValue();
            if ("instance".equals(spec.get("kind"))) {
                Field field=findField(target,entry.getKey());
                Class<?> type=spec.containsKey("className") ? Class.forName((String)spec.get("className")) : field.getType();
                if (!classes.contains(type)) classes.add(type);
            }
        }
        ctx.getMethod("register",Class[].class).invoke(context,(Object)classes.toArray(new Class<?>[0]));
        ctx.getMethod("refresh").invoke(context);
        Class<?> definition=Class.forName("org.springframework.beans.factory.annotation.AnnotatedGenericBeanDefinition");
        Object descriptor=definition.getConstructor(Class.class).newInstance(target);
        Class<?> generator=Class.forName("org.springframework.context.annotation.AnnotationBeanNameGenerator");
        String beanName=(String)generator.getMethod("generateBeanName",Class.forName("org.springframework.beans.factory.config.BeanDefinition"),
            Class.forName("org.springframework.beans.factory.support.BeanDefinitionRegistry")).invoke(generator.newInstance(),descriptor,context);
        Object bean=instance ? ctx.getMethod("getBean",String.class).invoke(context,beanName) : null;
        // Honor a project-provided mapper when one was explicitly configured.
        Map<?,?> mappers=(Map<?,?>)ctx.getMethod("getBeansOfType",Class.class).invoke(context,mapper.getClass());
        if (mappers.size()==1) mapper=mappers.values().iterator().next();
        return bean;
    }

    @SuppressWarnings("unchecked")
    private Object mock(final String dependency,Class<?> type,final Map<String,Object> spec) throws Exception {
        final InvocationHandler handler=new InvocationHandler() { public Object invoke(Object proxy,Method method,Object[] arguments) throws Throwable {
            if (method.getDeclaringClass()==Object.class) {
                if ("toString".equals(method.getName())) return "Mock("+dependency+")";
                if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
                return proxy==arguments[0];
            }
            return answer(dependency,method,arguments==null ? new Object[0] : arguments,spec);
        }};
        if (type.isInterface()) return Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},handler);
        Class<?> answer;
        try { answer=Class.forName("org.mockito.stubbing.Answer"); }
        catch (ClassNotFoundException e) { throw new IllegalArgumentException("Mocking class "+type.getName()+" requires mockito-core on the project's test classpath; interface mocks need no Mockito."); }
        Object callback=Proxy.newProxyInstance(answer.getClassLoader(),new Class<?>[]{answer},new InvocationHandler() {
            public Object invoke(Object proxy,Method method,Object[] args) throws Throwable {
                if (!"answer".equals(method.getName())) return null;
                Object invocation=args[0]; Class<?> call=Class.forName("org.mockito.invocation.InvocationOnMock");
                Method called=(Method)call.getMethod("getMethod").invoke(invocation);
                Object[] arguments=(Object[])call.getMethod("getArguments").invoke(invocation);
                return handler.invoke(call.getMethod("getMock").invoke(invocation),called,arguments);
            }
        });
        return Class.forName("org.mockito.Mockito").getMethod("mock",Class.class,answer).invoke(null,type,callback);
    }
    @SuppressWarnings("unchecked")
    private Object answer(String dependency,Method method,Object[] arguments,Map<String,Object> spec) throws Exception {
        Map<String,Object> call=new LinkedHashMap<String,Object>(); call.put("dependency",dependency); call.put("method",method.getName()); call.put("arguments",arguments); mockCalls.add(call);
        Object stubs=spec.get("stubs");
        if (stubs instanceof List) for (Object entry:(List<?>)stubs) {
            if (!(entry instanceof Map)) throw new IllegalArgumentException("Mock stubs must be objects.");
            Map<String,Object> stub=(Map<String,Object>)entry;
            if (!method.getName().equals(stub.get("method"))) continue;
            if (stub.containsKey("parameterTypes") && !signature(method,(List<String>)stub.get("parameterTypes"))) continue;
            if (stub.containsKey("args")) {
                List<Object> expected=(List<Object>)stub.get("args"); if (expected.size()!=arguments.length) continue;
                Object[] converted=new Object[expected.size()];
                for (int i=0;i<converted.length;i++) converted[i]=convert(expected.get(i),method.getGenericParameterTypes()[i]);
                if (!json(converted).equals(json(arguments))) continue;
            }
            if (stub.containsKey("throws")) throw new IllegalStateException(String.valueOf(stub.get("throws")));
            if (method.getReturnType()==void.class) return null;
            if (!stub.containsKey("returns")) throw new IllegalArgumentException("Mock "+dependency+"."+method.getName()+" needs returns or throws.");
            return convert(stub.get("returns"),method.getGenericReturnType());
        }
        throw new IllegalStateException("No mock response configured for "+dependency+"."+method.getName()+json(arguments));
    }

    @SuppressWarnings("unchecked") private Map<String,Object> read(String json) throws Exception { return (Map<String,Object>)readAny(json,Map.class); }
    private Object readAny(String json,Class<?> type) throws Exception { return mapper.getClass().getMethod("readValue",String.class,Class.class).invoke(mapper,json,type); }
    private Object convert(Object value,Type type) throws Exception {
        if (value==null && type instanceof Class && ((Class<?>)type).isPrimitive()) throw new IllegalArgumentException("null cannot be passed to "+type);
        if (type instanceof TypeVariable || type instanceof WildcardType) throw new IllegalArgumentException("Use a concrete parameter type instead of "+type);
        Object factory=mapper.getClass().getMethod("getTypeFactory").invoke(mapper);
        Object javaType=factory.getClass().getMethod("constructType",Type.class).invoke(factory,type);
        return mapper.getClass().getMethod("convertValue",Object.class,Class.forName("com.fasterxml.jackson.databind.JavaType")).invoke(mapper,value,javaType);
    }
    private String json(Object value) throws Exception { return (String)mapper.getClass().getMethod("writeValueAsString",Object.class).invoke(mapper,value); }
    private static String string(Object value,String fallback) { return value==null ? fallback : String.valueOf(value); }
    private static Throwable unwrap(Throwable error) {
        while (error instanceof InvocationTargetException && error.getCause()!=null) error=error.getCause(); return error;
    }
    private static String stack(Throwable error) { StringWriter out=new StringWriter(); error.printStackTrace(new PrintWriter(out)); return out.toString(); }
    private static String quote(String value) {
        StringBuilder out=new StringBuilder("\"");
        for (int i=0;i<value.length();i++) { char c=value.charAt(i);
            if (c=='"' || c=='\\') out.append('\\').append(c);
            else if (c<32) out.append(String.format("\\u%04x",(int)c)); else out.append(c);
        } return out.append('"').toString();
    }
    private static void failure(Path dir,Throwable error) throws IOException {
        // Preserve an invocation's detailed error when its child subsequently exits nonzero.
        if (Files.exists(dir.resolve("result.json"))) return;
        atomic(dir,"{\"success\":false,\"valueJson\":null,\"durationMs\":0,\"error\":"+quote(error.toString())+",\"stackTrace\":"+quote(stack(error))+",\"mockCallsJson\":\"[]\"}");
    }
    private static void atomic(Path dir,String json) throws IOException {
        Path temporary=dir.resolve("result.tmp"); Files.write(temporary,json.getBytes(StandardCharsets.UTF_8));
        try { Files.move(temporary,dir.resolve("result.json"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }
        catch (AtomicMoveNotSupportedException e) { Files.move(temporary,dir.resolve("result.json"),StandardCopyOption.REPLACE_EXISTING); }
    }
}
