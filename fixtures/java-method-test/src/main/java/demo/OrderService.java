package demo;

import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.annotation.*;
import org.springframework.transaction.support.*;

@Service
public class OrderService implements OrderOperations {
    private final Repository repository;
    public OrderService(Repository repository) { this.repository=repository; }
    public Order load(long id) { return repository.load(id); }
    public List<Order> echo(List<Order> orders) { return orders; }
    public Map<String,Order> mapping(Map<String,Order> orders) { return orders; }
    public String overloaded(int value) { return "int:"+value; }
    public String overloaded(String value) { return "string:"+value; }
    @Transactional
    public boolean transactionActive() { return TransactionSynchronizationManager.isActualTransactionActive(); }
    public static int sum(int a,int b) { return a+b; }
    public static String state(State state) { return state.name(); }
    public static java.util.concurrent.CompletionStage<String> async() { throw new AssertionError("Async methods must not be executed"); }
    public static void failure() { throw new IllegalStateException("fixture failure"); }
    public static void slow() throws Exception { Thread.sleep(30000); }
    public interface Repository { Order load(long id); }
    public enum State { ACTIVE, DISABLED }
    public static class ConcreteRepository { public String value(int id) { throw new AssertionError("Real dependency called"); } }
    public static class ConcreteService {
        private final ConcreteRepository repository;
        public ConcreteService(ConcreteRepository repository) {this.repository=repository;}
        public String value(int id) { return repository.value(id); }
    }
    public static class Order {
        public long id;
        public String name;
    }
    @Configuration
    @EnableTransactionManagement
    public static class Config {
        @Bean public PlatformTransactionManager transactionManager() {
            return new AbstractPlatformTransactionManager() {
                protected Object doGetTransaction() { return new Object(); }
                protected void doBegin(Object transaction,TransactionDefinition definition) {}
                protected void doCommit(DefaultTransactionStatus status) {}
                protected void doRollback(DefaultTransactionStatus status) {}
            };
        }
    }
    @Service
    public static class GreetingService {
        @Value("${greeting:hello}") private String greeting;
        public String greet(String name) { return greeting+" "+name; }
    }
}
